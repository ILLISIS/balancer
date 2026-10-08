import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as lib from "@clusterio/lib";
import type { ControllerPluginContext } from "@clusterio/controller";
import { lifecycle, rateLimited } from "universal_edges/runtime";
import { setBalancerApi } from "./api.js";
import { MoveRequest, PreflightRequest, StatusRequest, TelemetryEvent, type Status } from "./contracts.js";
import { RETRY_FAILED_MS, failovers, goneHosts, wasRunningBefore } from "./failover.js";
import { Mover, type MoverPort } from "./mover.js";
import { openState } from "./state.js";
import { SaveStore, copyable } from "./store.js";
import { candidates, verdict } from "./targets.js";
import { SAMPLE_MS, Telemetry } from "./telemetry.js";
import { proxyStream, pull, push } from "./transfer.js";

/** §5.2 step 1: 1800 ticks, 30 s of game time (plan ruling 4). */
const PREFLIGHT_TICKS = 1800;
/** The name a move pushes the copy under; the host may store it as balancer-2.zip and so on (plan ruling 10). */
const MOVE_SAVE = "balancer.zip";
/** §4.3 unit 3: the decider's pass. */
const PASS_MS = 30_000;

/**
 * The controller plugin (§4.3): the save store, the mover over Clusterio, the manual move and the status, the API for
 * gridworld, and the 30 s pass.
 */
export default async function loadControllerPlugin(context: ControllerPluginContext) {
	const { controller, logger, plugin } = context;
	// §4.5: set before the first await, so gridworld's first pass can find it; it answers once the moves are loaded.
	let mover: Mover | undefined;
	const listeners = new Set<(instanceId: number) => void>();
	setBalancerApi({
		moving: id => mover?.moving(id) ?? false,
		onMoveFinished: listener => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	});

	const config = controller.config;
	const dir = path.resolve(config.get("controller.database_directory"));
	const { state, save } = await openState(dir);
	const persist = () => save().catch((err: Error) => {
		logger.error(`balancer: writing balancer.json failed: ${err.message}`);
	});
	const telemetry = new Telemetry();
	const store = new SaveStore(state, path.join(dir, "balancer", "saves"), {
		pull: (id, name, file) => pull(controller, id, name, file),
		save: persist,
		log: (phase, fields, level = "info") => lifecycle(logger, "balancer.store", phase, fields, level),
		now: Date.now,
	});

	/** When the balancer saw each disconnected host go (drop or close); a host down at start counts from now. */
	const gone = new Map<number, number>();
	for (const h of controller.hosts.values()) {
		if (!h.connected) {
			gone.set(h.id, Date.now());
		}
	}

	const instance = (id: number) => controller.instances.get(id);
	// The raw records: users.values() builds a User per record, on every call.
	const players = (id: number) => [...controller.users.records.values()].filter(u => u.instances.has(id)).length;
	const tiles = () => [...controller.instances.values()].map(i => ({
		id: i.id, host: i.config.get("instance.assigned_host"), status: i.status,
	}));
	const rcon = async (id: number, command: string) => String(
		await controller.sendTo({ instanceId: id }, new lib.InstanceSendRconRequest(command)),
	);

	const port: MoverPort = {
		now: Date.now,
		wait: ms => sleep(ms),
		candidates: (id, from) => candidates(
			from,
			[...controller.hosts.values()],
			tiles(),
			i => telemetry.last(i),
			i => telemetry.meanMs(i),
			config.get("balancer.ups_floor"),
			config.get("balancer.busy_tile_ms"),
		),
		hostConnected: h => controller.hosts.get(h)?.connected ?? false,
		status: id => instance(id)?.status ?? "unknown",
		players,
		loadedSave: id => {
			const files = [...controller.saves.values()].filter(s => s.instanceId === id && copyable(s));
			return (files.find(s => s.loaded) ?? files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0])?.name;
		},
		hasCopy: id => store.copy(id) !== undefined,
		// §5.2 step 1: the copy goes to the target through a proxy stream; its tiles' samples during the run, plus the
		// one that covers its end, are the UPS check (plan ruling 4).
		preflight: async (id, hostId) => {
			const inst = instance(id);
			const packId = inst?.config.get("factorio.mod_pack_id") ?? config.get("controller.default_mod_pack_id");
			const pack = packId === null ? undefined : controller.modPacks.get(packId);
			if (!inst || !pack) {
				throw new Error(`instance ${id} has no mod pack`);
			}
			const file = store.file(id);
			const stream = proxyStream(controller, { path: file, size: (await fs.stat(file)).size });
			const from = Date.now();
			try {
				const version = inst.config.get("factorio.version");
				const r = await controller.sendTo(
					{ hostId }, new PreflightRequest(id, stream.id, pack, version, PREFLIGHT_TICKS),
				);
				await sleep(SAMPLE_MS + 1_000);
				const running = tiles().filter(t => t.host === hostId && t.status === "running");
				const ups = running.flatMap(t => telemetry.minUps(t.id, from, Date.now()) ?? []);
				const minUps = ups.length > 0 ? Math.min(...ups) : null;
				const pass = verdict(
					r.msPerTick, minUps, config.get("balancer.preflight_max_ms"), config.get("balancer.ups_floor"),
					running.length > 0,
				);
				return { pass, msPerTick: r.msPerTick, minUps };
			} finally {
				stream.events.emit("close");
			}
		},
		tick: async id => {
			const reply = (await rcon(id, "/sc rcon.print(game.tick)")).trim();
			if (!/^\d+$/.test(reply)) {
				throw new Error(`instance ${id} answered no tick`);
			}
			return Number(reply);
		},
		stop: async id => {
			await controller.sendTo({ instanceId: id }, new lib.InstanceStopRequest());
		},
		// C27: SIGKILL, no save.
		kill: async id => {
			await controller.sendTo({ instanceId: id }, new lib.InstanceKillRequest());
		},
		pull: (id, name) => store.pull(id, name),
		// §5.2 step 4: in-process, not a message to itself (link.ts:556 refuses that; spec §2).
		assign: (id, hostId) => controller.instances.assignInstance(id, hostId),
		push: id => push(controller, id, store.file(id), MOVE_SAVE),
		start: async (id, name) => {
			await controller.sendTo({ instanceId: id }, new lib.InstanceStartRequest(name));
		},
		save: persist,
		log: (phase, m, fields = {}, level = "info") => lifecycle(logger, "balancer.move", phase, {
			move: m.id, instance: m.instanceId, from: m.from, to: m.to, reason: m.reason, ...fields,
		}, level),
		finished: m => {
			for (const listener of listeners) {
				try {
					listener(m.instanceId);
				} catch (err: any) {
					logger.error(`balancer: a move-finished listener threw: ${err.message}`);
				}
			}
		},
	};
	const moves = new Mover(state.moves, state.bad, port, () => ({
		maxConcurrent: config.get("balancer.max_concurrent_moves"),
		badPairHours: config.get("balancer.bad_pair_hours"),
	}));
	mover = moves;

	controller.handle(TelemetryEvent, async (event: TelemetryEvent, src: lib.Address) => {
		telemetry.receive(src.id, event.samples);
	});

	// §11's manual move: refused unless the tile is empty (B4), has a stored copy and isn't moving already.
	controller.handle(MoveRequest, async (request: MoveRequest) => {
		const inst = instance(request.instanceId);
		if (!inst) {
			throw new lib.RequestError(`instance ${request.instanceId} does not exist`);
		}
		const from = inst.config.get("instance.assigned_host");
		const to = request.hostId;
		const refuse = (why: string) => new lib.RequestError(`${inst.config.get("instance.name")} can't move: ${why}`);
		if (moves.moving(inst.id)) {
			throw refuse("it is moving already");
		}
		if (inst.status !== "running" && inst.status !== "stopped") {
			throw refuse(`it is ${inst.status}; a move needs it running or stopped`);
		}
		if (players(inst.id) > 0) {
			throw refuse("players are on it; only empty tiles move (B4)");
		}
		if (!store.copy(inst.id)) {
			throw refuse("the controller holds no copy of its save yet");
		}
		if (to !== undefined && (to === from || !port.hostConnected(to))) {
			throw refuse(to === from ? `it is on host ${to} already` : `host ${to} is not connected`);
		}
		const m = moves.add({ instanceId: inst.id, from, to, reason: "manual", wasRunning: inst.status === "running" });
		return { moveId: m.id };
	});

	controller.handle(StatusRequest, async (): Promise<Status> => ({
		hosts: [...controller.hosts.values()].map(h => ({
			id: h.id, name: h.name, connected: h.connected, goneSinceMs: gone.get(h.id) ?? null,
		})),
		tiles: [...controller.instances.values()].map(i => ({
			id: i.id,
			name: i.config.get("instance.name"),
			host: i.config.get("instance.assigned_host"),
			status: i.status,
			ups: telemetry.last(i.id)?.ups ?? null,
			ms: telemetry.meanMs(i.id) ?? null,
			players: players(i.id),
			copyMtimeMs: store.copy(i.id)?.mtimeMs ?? null,
		})),
		moves: state.moves,
	}));

	// §5.1: copy every newer save, and the ones the hosts listed before this start.
	controller.saves.on("update", (saves: lib.SaveDetails[]) => store.updated(saves));
	// Not at load: hosts connect after the plugins load, so those pulls would all fail. The host-back hook feeds them.

	let resumed = false;
	const announced = new Set<number>();
	controller.hooks.hostConnectionEvent.attach(plugin.name, async (connection, event) => {
		const id = connection.id;
		if (event === "drop" || event === "close") {
			if (!gone.has(id)) {
				gone.set(id, Date.now());
				lifecycle(logger, "balancer.host", "gone", { host: id, event }, "warn");
			}
		} else if (gone.delete(id)) {
			announced.delete(id);
			lifecycle(logger, "balancer.host", "back", { host: id, event });
			// C28: a reconnected host's saves don't re-fire the update, and at start every host counts as gone.
			store.updated([...controller.saves.values()].filter(
				s => instance(s.instanceId)?.config.get("instance.assigned_host") === id,
			));
			if (resumed) {
				moves.pump();
			}
		}
	});

	// §5.3: an instance running when its host went is started on the target; a stopped one is only reassigned. Its
	// status turns "unknown" when the host's session closes; any real status after that clears it.
	controller.hooks.instanceStatusChanged.attach(plugin.name, async (inst, prev) => {
		const i = state.wasRunning.indexOf(inst.id);
		if (inst.status === "unknown" && (prev === "running" || prev === "starting") && i === -1) {
			state.wasRunning.push(inst.id);
			await persist();
		} else if (inst.status !== "unknown" && i !== -1) {
			state.wasRunning.splice(i, 1);
			await persist();
		}
	});
	const warn = rateLimited(logger, 600_000);
	/** §5.3: every gone host's instances move with their stored copies; candidates are pre-flighted one at a time. */
	const failover = () => {
		const now = Date.now();
		const graceMs = config.get("balancer.failover_grace_minutes") * 60_000;
		const ids = goneHosts(gone, now, graceMs, port.hostConnected);
		for (const id of ids.filter(h => !announced.has(h))) {
			announced.add(id);
			lifecycle(logger, "balancer.failover", "gone", { host: id, since: gone.get(id) }, "warn");
		}
		const failedLately = (id: number) => state.moves.some(m => m.instanceId === id && m.reason === "failover"
			&& m.step === "failed" && now - (m.endedAt ?? 0) < RETRY_FAILED_MS);
		const { move, noCopy } = failovers(ids, tiles(), id => moves.moving(id) || failedLately(id), port.hasCopy);
		for (const f of move) {
			const wasRunning = wasRunningBefore(f.instanceId, state.wasRunning, state.moves);
			moves.add({ instanceId: f.instanceId, from: f.from, reason: "failover", wasRunning });
		}
		for (const id of noCopy) {
			const fields = { op: "balancer.failover", phase: "no_copy", instance: id };
			warn(`no_copy:${id}`, "balancer.failover no_copy: no stored copy, so it stays on its gone host", fields);
		}
	};

	// §4.3 unit 3, every 30 s. The first pass resumes the moves a restart interrupted, once the hosts have had time to
	// reconnect (plan ruling 15).
	const pass = () => {
		if (!resumed) {
			resumed = true;
			moves.resume();
		}
		if (config.get("balancer.enabled")) {
			failover();
		}
		moves.pump();
	};
	const timer = setInterval(pass, PASS_MS);
	controller.hooks.shutdown.attach(plugin.name, async () => {
		clearInterval(timer);
	});
}
