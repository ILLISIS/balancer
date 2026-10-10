import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as lib from "@clusterio/lib";
import type { ControllerPluginContext } from "@clusterio/controller";
import { lifecycle, rateLimited } from "universal_edges/runtime";
import { setBalancerApi } from "./api.js";
import {
	BenchmarkRequest, DrainRequest, FactorioVersionEvent, HostBenchmarkRequest, HostLeavingEvent, MoveRequest,
	PreflightRequest, StatusRequest, TelemetryEvent, type Check, type Move, type Status,
} from "./contracts.js";
import { applyCheck, benchmarksDue, decide, dueChecks, type Add, type View } from "./decider.js";
import { RETRY_FAILED_MS, adoptOrphans, failovers, forget, goneHosts, wasRunningBefore } from "./failover.js";
import { Mover, type MoverPort } from "./mover.js";
import { openState } from "./state.js";
import { SaveStore, copyable } from "./store.js";
import { candidates, failoverCandidates, predictedMs, verdict } from "./targets.js";
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
	/** state.draining once loaded; the drain handler edits that array in place. */
	let draining: number[] = [];
	const listeners = new Set<(instanceId: number) => void>();
	setBalancerApi({
		moving: id => mover?.moving(id) ?? false,
		draining: id => draining.includes(id),
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
	draining = state.draining;
	const persist = () => save().catch((err: Error) => {
		logger.error(`balancer: writing balancer.json failed: ${err.message}`);
	});
	const telemetry = new Telemetry();
	/** Memory amendment §3.1: a tile's figure rose since the last pass, which then writes balancer.json (MR5). */
	let figuresRose = false;
	const store = new SaveStore(state, path.join(dir, "balancer", "saves"), {
		pull: (id, name, file) => pull(controller, id, name, file),
		host: id => controller.instances.get(id)?.config.get("instance.assigned_host") ?? null,
		save: persist,
		log: (phase, fields, level = "info") => lifecycle(logger, "balancer.store", phase, fields, level),
		now: Date.now,
	});

	/** When the balancer saw each disconnected host go (drop or close); a host down at start counts from now. */
	const gone = new Map<number, number>();
	// C51: performance.now(), so a wall-clock step can't make a host look gone before its fence fires.
	const wallOf = (mono: number) => Date.now() - (performance.now() - mono);
	for (const h of controller.hosts.values()) {
		if (!h.connected) {
			gone.set(h.id, performance.now());
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

	/** Hosts running the join benchmark now (R11): not targets, not overload sources. */
	const benchmarking = new Set<number>();
	const speedOf = (hostId: number) => state.hosts[hostId]?.bench?.speed ?? null;
	/** §5.6: learned slots override the benchmark's; null: no limit. */
	const slotsOf = (hostId: number) => state.hosts[hostId]?.learned ?? state.hosts[hostId]?.bench?.slots ?? null;
	/** A host's busy tiles (§5.8): running, at balancer.busy_tile_ms or more. */
	const busyOn = (hostId: number) => tiles().filter(t => t.host === hostId && t.status === "running"
		&& (telemetry.meanMs(t.id) ?? 0) >= config.get("balancer.busy_tile_ms")).length;
	/** §5.8's view of the hosts. */
	const hostFacts = () => [...controller.hosts.values()].map(h => ({
		id: h.id,
		open: h.connected && !state.draining.includes(h.id) && !benchmarking.has(h.id),
		speed: speedOf(h.id),
		slots: slotsOf(h.id),
	}));

	/** Tier 1 of §5.8: the strict candidates for a tile on `from`. */
	const strict = (from: number | null, fits?: (hostId: number) => boolean) => candidates(
		from, hostFacts(), tiles(), i => telemetry.last(i), i => telemetry.meanMs(i),
		config.get("balancer.ups_floor"), config.get("balancer.busy_tile_ms"), fits,
	);

	const port: MoverPort = {
		now: Date.now,
		wait: ms => sleep(ms),
		candidates: (id, from, reason) => {
			const floor = config.get("balancer.ups_floor");
			if (reason === "failover") {
				return failoverCandidates(
					from, hostFacts(), tiles(), i => telemetry.last(i), i => telemetry.meanMs(i), floor,
					config.get("balancer.failover_floor"), config.get("balancer.busy_tile_ms"),
				);
			}
			let fits: ((hostId: number) => boolean) | undefined;
			if (reason === "overload") {
				const ms = telemetry.meanMs(id);
				const fromSpeed = from === null ? null : speedOf(from);
				fits = h => {
					const toSpeed = speedOf(h);
					return ms === undefined || fromSpeed === null || toSpeed === null
						|| predictedMs(ms, fromSpeed, toSpeed) < 1000 / floor;
				};
			}
			return strict(from, fits);
		},
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
		preflight: async (id, hostId, reason) => {
			const inst = instance(id);
			const packId = inst?.config.get("factorio.mod_pack_id") ?? config.get("controller.default_mod_pack_id");
			const pack = packId === null ? undefined : controller.modPacks.get(packId);
			if (!inst || !pack) {
				throw new Error(`instance ${id} has no mod pack`);
			}
			// A failover target outside tier 1 (a full host) is judged on the emergency floor. Decided before the run,
			// whose own load can drop the host's tiles out of tier 1.
			const emergency = reason === "failover"
				&& !strict(inst.config.get("instance.assigned_host") ?? null).includes(hostId);
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
					r.msPerTick, minUps, config.get("balancer.preflight_max_ms"),
					config.get(emergency ? "balancer.failover_floor" : "balancer.ups_floor"), running.length > 0,
				);
				return { pass, msPerTick: r.msPerTick, minUps, busy: busyOn(hostId) };
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
		assign: async (id, hostId) => {
			await controller.instances.assignInstance(id, hostId);
		},
		push: async id => {
			const name = await push(controller, id, store.file(id), MOVE_SAVE);
			// C49, N1: zero only now. Until the push the host may still list an earlier stint's saves for this
			// tile, and a re-feed would let one replace the fresh copy; after it, the pushed copy is the newest.
			store.hostChanged(id);
			await persist();
			return name;
		},
		start: async (id, name) => {
			await controller.sendTo({ instanceId: id }, new lib.InstanceStartRequest(name));
		},
		save: persist,
		log: (phase, m, fields = {}, level = "info") => {
			const c = store.copy(m.instanceId);
			const mtime = c && (c.mtimeMs || c.pulledAt); // N2: mtime is 0 until the new host's first save
			// C53: a failover rolls the tile back to its copy; say how far.
			const age = phase === "queued" && m.reason === "failover" && mtime !== undefined
				? { copyAgeMinutes: Math.round((Date.now() - mtime) / 60_000) } : {};
			lifecycle(logger, "balancer.move", phase, {
				move: m.id, instance: m.instanceId, from: m.from, to: m.to, reason: m.reason, ...age, ...fields,
			}, level);
		},
		finished: m => {
			if (m.step === "done") {
				telemetry.forget(m.instanceId); // S2: its samples from the old host don't count on the new one
			}
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
		graceMs: config.get("balancer.failover_grace_minutes") * 60_000,
	}));
	mover = moves;

	// C34: a host shutting down cleanly says which tiles ran, before their stops hide it.
	controller.handle(HostLeavingEvent, async (event: HostLeavingEvent) => {
		for (const id of event.running) {
			if (!state.wasRunning.includes(id)) {
				state.wasRunning.push(id);
			}
		}
		await persist();
	});

	controller.handle(TelemetryEvent, async (event: TelemetryEvent, src: lib.Address) => {
		telemetry.receive(src.id, event.samples);
		// Memory amendment §3.1: the largest figure the tile has reported, kept across moves and restarts.
		const top = Math.max(0, ...event.samples.map(s => s.mem ?? 0));
		if (top > (state.memory[src.id] ?? 0)) {
			state.memory[src.id] = top;
			figuresRose = true;
		}
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

	// §5.4: the operator's drain toggle. Drain runs whatever balancer.enabled says (P4).
	controller.handle(DrainRequest, async (request: DrainRequest) => {
		if (!controller.hosts.get(request.hostId)) {
			throw new lib.RequestError(`host ${request.hostId} does not exist`);
		}
		const i = state.draining.indexOf(request.hostId);
		if (request.on && i === -1) {
			state.draining.push(request.hostId);
		} else if (!request.on && i !== -1) {
			state.draining.splice(i, 1);
		}
		await persist();
		lifecycle(logger, "balancer.drain", request.on ? "on" : "off", { host: request.hostId });
	});

	/** §5.7: each host's newest Factorio, as it reported at its last connect (R8). */
	const versions = new Map<number, string>();
	/** Hosts whose benchmark failed this session: not run again automatically before they reconnect. */
	const benchFailed = new Set<number>();
	const referenceFile = path.join(dir, "balancer", "reference.zip");
	/** R7: the reference a result was measured on; undefined until the default one is frozen. */
	const referenceKey = (): string | undefined => {
		const set = config.get("balancer.reference_save");
		if (set) {
			return `file:${path.resolve(set)}`;
		}
		return state.reference ? `tile:${state.reference.instanceId}` : undefined;
	};
	/**
	 * P5, R7: balancer.reference_save, with no mods on the host's newest Factorio; unset, the busiest tile's copy (at
	 * balancer.busy_tile_ms or more), with that tile's mod pack and Factorio version, frozen at its first need.
	 * Undefined while there is none.
	 */
	const reference = async (): Promise<
		{ file: string; modPack: lib.ModPack | null; version: string; key: string } | undefined
	> => {
		const set = config.get("balancer.reference_save");
		if (set) {
			return { file: path.resolve(set), modPack: null, version: "latest", key: `file:${path.resolve(set)}` };
		}
		if (!state.reference) {
			const ms = (id: number) => telemetry.meanMs(id) ?? 0;
			const [pick] = [...controller.instances.values()]
				.filter(i => store.copy(i.id) !== undefined && ms(i.id) >= config.get("balancer.busy_tile_ms"))
				.sort((a, b) => ms(b.id) - ms(a.id));
			if (!pick) {
				return undefined;
			}
			await fs.mkdir(path.dirname(referenceFile), { recursive: true });
			await fs.copyFile(store.file(pick.id), referenceFile);
			state.reference = {
				instanceId: pick.id,
				modPackId: pick.config.get("factorio.mod_pack_id") ?? config.get("controller.default_mod_pack_id"),
				version: pick.config.get("factorio.version"),
			};
			await persist();
			lifecycle(logger, "balancer.benchmark", "reference", { instance: pick.id, ms_per_tick: ms(pick.id) });
		}
		const { instanceId, modPackId, version } = state.reference;
		const modPack = modPackId === null ? null : controller.modPacks.get(modPackId);
		if (modPack === undefined) {
			throw new Error(`the reference's mod pack ${modPackId} no longer exists`);
		}
		return { file: referenceFile, modPack, version, key: `tile:${instanceId}` };
	};
	/**
	 * §5.7: stream the reference to the host (per run) and run the join benchmark there; record its speed and slots.
	 * "Benchmark now" (`operator`) also clears the host's learned slots (R10). A rejected or failed run leaves the host
	 * unbenchmarked (§5.7) and is logged.
	 */
	const runBenchmark = async (hostId: number, operator: boolean) => {
		benchmarking.add(hostId);
		const started = Date.now();
		try {
			const ref = await reference();
			if (!ref) {
				throw new Error("no reference save yet");
			}
			lifecycle(logger, "balancer.benchmark", "started", { host: hostId, reference: ref.key, operator });
			const stream = proxyStream(controller, { path: ref.file, size: (await fs.stat(ref.file)).size });
			try {
				const r = await controller.sendTo(
					{ hostId }, new HostBenchmarkRequest(stream.id, ref.modPack, ref.version),
				);
				const host = state.hosts[hostId] ?? {};
				const version = versions.get(hostId) ?? "unknown";
				host.bench = { speed: r.speed, slots: r.slots, version, ref: ref.key, at: Date.now() };
				if (operator) {
					delete host.learned;
				}
				state.hosts[hostId] = host;
				benchFailed.delete(hostId);
				lifecycle(logger, "balancer.benchmark", "done", {
					host: hostId, speed: r.speed, slots: r.slots, cores: r.cores, runs: r.runs,
					wall_ms: Date.now() - started,
				});
			} finally {
				stream.events.emit("close");
			}
		} catch (err: any) {
			benchFailed.add(hostId);
			delete state.hosts[hostId]?.bench;
			lifecycle(logger, "balancer.benchmark", "failed", { host: hostId, error: err.message }, "warn");
		} finally {
			benchmarking.delete(hostId);
			await persist();
		}
	};
	/** §5.7, R3: each pass, the join benchmark starts on each quiet host whose result is missing or stale. */
	const benchmarks = (v: View) => {
		const key = referenceKey();
		if (key === undefined) {
			// Freezes the default reference once a tile is busy; the next pass benchmarks.
			void reference().catch((err: Error) => {
				logger.error(`balancer: freezing the reference save failed: ${err.message}`);
			});
			return;
		}
		const skip = (h: number) => benchmarking.has(h) || benchFailed.has(h);
		for (const h of benchmarksDue(v, versions, state.hosts, key, skip)) {
			void runBenchmark(h, false);
		}
	};

	controller.handle(FactorioVersionEvent, async (event: FactorioVersionEvent, src: lib.Address) => {
		versions.set(src.id, event.version);
		benchFailed.delete(src.id); // a new session: a failed benchmark may run again
	});

	// §5.7's "benchmark now": it runs whatever the host carries (the operator chose), and answers once it has started.
	controller.handle(BenchmarkRequest, async (request: BenchmarkRequest) => {
		if (!port.hostConnected(request.hostId)) {
			throw new lib.RequestError(`host ${request.hostId} is not connected`);
		}
		if (benchmarking.has(request.hostId)) {
			throw new lib.RequestError(`host ${request.hostId} is running its benchmark already`);
		}
		benchmarking.add(request.hostId); // claimed before any await, so no second run can start meanwhile
		try {
			if (!await reference()) {
				throw new lib.RequestError(
					"no reference save yet: set balancer.reference_save, or wait until a tile is busy",
				);
			}
		} catch (err) {
			benchmarking.delete(request.hostId);
			throw err;
		}
		void runBenchmark(request.hostId, true);
	});

	controller.handle(StatusRequest, async (): Promise<Status> => ({
		hosts: [...controller.hosts.values()].map(h => ({
			id: h.id,
			name: h.name,
			connected: h.connected,
			goneSinceMs: gone.has(h.id) ? wallOf(gone.get(h.id)!) : null,
			speed: speedOf(h.id),
			slots: slotsOf(h.id),
			learned: state.hosts[h.id]?.learned !== undefined,
			busy: busyOn(h.id),
			draining: state.draining.includes(h.id),
			benchmarking: benchmarking.has(h.id),
		})),
		tiles: [...controller.instances.values()].map(i => ({
			id: i.id,
			name: i.config.get("instance.name"),
			host: i.config.get("instance.assigned_host"),
			status: i.status,
			ups: telemetry.last(i.id)?.ups ?? null,
			ms: telemetry.meanMs(i.id) ?? null,
			players: players(i.id),
			// N2: pulledAt while mtime is 0
			copyMtimeMs: store.copy(i.id)?.mtimeMs || store.copy(i.id)?.pulledAt || null,
		})),
		moves: state.moves,
	}));

	// §5.1: copy every newer save.
	controller.saves.on("update", (saves: lib.SaveDetails[]) => store.updated(saves));
	// Not at load or at a host's connect: an instance's saves are fed once its host has listed it (P3, below).

	const announced = new Set<number>();
	controller.hooks.hostConnectionEvent.attach(plugin.name, async (connection, event) => {
		const id = connection.id;
		if (event === "drop" || event === "close") {
			if (!gone.has(id)) {
				gone.set(id, performance.now());
				lifecycle(logger, "balancer.host", "gone", { host: id, event }, "warn");
			}
		} else if (gone.delete(id)) {
			announced.delete(id);
			// C34: back before failover, the operator decides; a recorded start would surprise them.
			forget(state.wasRunning, tiles().filter(t => t.host === id).map(t => t.id));
			void persist();
			lifecycle(logger, "balancer.host", "back", { host: id, event });
			moves.pump(); // a move waiting for this host may go now (C43); the mover holds back before the first pass
		}
	});

	// §5.3: an instance running when its host went is started on the target; a stopped one is only reassigned. Its
	// status turns "unknown" when the host's session closes; running again clears it (C34).
	controller.hooks.instanceStatusChanged.attach(plugin.name, async (inst, prev) => {
		// P3 (spike 33c): a connect comes before the host's instance list; once the list makes the status known, the
		// host can upload. A reconnected host's saves don't re-fire the update (C28); at start every one is unknown.
		if (prev === "unknown" && inst.status !== "unknown" && inst.status !== "deleted") {
			store.updated([...controller.saves.values()].filter(s => s.instanceId === inst.id));
		}
		const i = state.wasRunning.indexOf(inst.id);
		if (inst.status === "deleted") { // C45
			forget(state.wasRunning, [inst.id]);
			delete state.memory[inst.id]; // MR6: a gone tile's peak no longer sets the no-figure estimate
			await store.drop(inst.id);
		} else if (inst.status === "unknown" && (prev === "running" || prev === "starting") && i === -1) {
			state.wasRunning.push(inst.id);
			await persist();
		} else if ((inst.status === "running" || inst.status === "starting") && i !== -1) {
			state.wasRunning.splice(i, 1);
			await persist();
		}
	});
	const warn = rateLimited(logger, 600_000);
	/** §5.3: every gone host's instances move with their stored copies; candidates are pre-flighted one at a time. */
	const failover = (): Add[] => {
		const now = Date.now();
		const graceMs = config.get("balancer.failover_grace_minutes") * 60_000;
		const ids = goneHosts(gone, performance.now(), graceMs, port.hostConnected);
		for (const id of ids.filter(h => !announced.has(h))) {
			announced.add(id);
			lifecycle(logger, "balancer.failover", "gone", { host: id, since: wallOf(gone.get(id)!) }, "warn");
		}
		const failedLately = (id: number) => state.moves.some(m => m.instanceId === id && m.reason === "failover"
			&& m.step === "failed" && now - (m.endedAt ?? 0) < RETRY_FAILED_MS);
		const orphansHome = adoptOrphans(tiles(), state.moves);
		const { move, noCopy } = failovers(ids, orphansHome, id => moves.moving(id) || failedLately(id), port.hasCopy);
		for (const id of noCopy) {
			const fields = { op: "balancer.failover", phase: "no_copy", instance: id };
			warn(`no_copy:${id}`, "balancer.failover no_copy: no stored copy, so it stays on its gone host", fields);
		}
		return move.map((f): Add => ({
			instanceId: f.instanceId, from: f.from, reason: "failover",
			wasRunning: wasRunningBefore(f.instanceId, state.wasRunning, state.moves),
		}));
	};

	/** What the decider reads (§4.3 unit 3): the cluster as it is now. */
	const view = (): View => ({
		now: Date.now(),
		connected: [...controller.hosts.values()].filter(h => h.connected).map(h => h.id),
		tiles: tiles().map(t => ({ ...t, players: players(t.id), hasCopy: port.hasCopy(t.id) })),
		moves: state.moves,
		draining: state.draining,
		benchmarking,
		telemetry,
		floor: config.get("balancer.ups_floor"),
		speed: speedOf,
		busyMs: config.get("balancer.busy_tile_ms"),
		lagMs: config.get("balancer.lag_minutes") * 60_000,
		checkMs: config.get("balancer.after_check_minutes") * 60_000,
	});
	/** §5.6: record an after-check; a failed one marks its pair bad and lowers its host's slots. Logged either way. */
	const judge = (m: Move, check: Check) => {
		const badMs = config.get("balancer.bad_pair_hours") * 3_600_000;
		const learned = applyCheck(m, check, state, Date.now(), badMs, config.get("balancer.ups_floor"));
		let outcome = "skipped";
		if (check.ok !== null) {
			outcome = check.ok ? "passed" : "failed";
		}
		lifecycle(logger, "balancer.check", outcome, {
			move: m.id, instance: m.instanceId, host: m.to, reason: m.reason, ups: check.ups, ms: check.ms,
			others_min_ups: check.othersMinUps, predicted_ms: m.preflight?.msPerTick ?? null,
			...(learned === undefined ? {} : { learned_slots: learned }),
		}, check.ok === false ? "warn" : "info");
		void persist();
	};

	// §4.3 unit 3, every 30 s. The first pass lets the mover start; it resumes the moves a restart interrupted as their
	// hosts reconnect, or after the grace (plan ruling 15, C43). The after-checks due are judged every pass; then the
	// first rule with work queues its moves (R1).
	const pass = () => {
		moves.resume();
		const v = view();
		for (const { move, check } of dueChecks(v)) {
			judge(move, check);
		}
		// P4: balancer.enabled gates failover, overload and the after-check's re-move; drain runs either way.
		const enabled = config.get("balancer.enabled");
		const d = decide(v, enabled ? failover() : [], enabled);
		for (const a of d.add) {
			moves.add(a);
		}
		for (const b of d.beyond) {
			const fields = { op: "balancer.overload", phase: "beyond", host: b.host, instance: b.instance };
			warn(`beyond:${b.instance}`, "balancer.overload beyond: it lags as its host's only busy tile", fields);
		}
		benchmarks(v); // P4: the join benchmark runs whatever balancer.enabled says
		moves.pump();
		if (figuresRose) { // MR5: one write a pass at most
			figuresRose = false;
			void persist();
		}
	};
	const timer = setInterval(pass, PASS_MS);
	controller.hooks.shutdown.attach(plugin.name, async () => {
		clearInterval(timer);
	});
}
