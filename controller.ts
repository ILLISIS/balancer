import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as lib from "@clusterio/lib";
import type { ControllerPluginContext } from "@clusterio/controller";
import { lifecycle, rateLimited } from "universal_edges/runtime";
import { setBalancerApi } from "./api.js";
import {
	ClearMarksRequest, DrainRequest, HostLeavingEvent, HostMemoryEvent, MoveRequest, PreflightRequest, RESERVE_MS,
	StatusRequest, TelemetryEvent, type Check, type Move, type Status,
} from "./contracts.js";
import { applyCheck, clearMarks, decide, dueChecks, markOf, memoryTimers, type Add, type View } from "./decider.js";
import { RETRY_FAILED_MS, adoptOrphans, failovers, forget, goneHosts, stranded, wasRunningBefore } from "./failover.js";
import { Mover, ended, type MoverPort } from "./mover.js";
import { openState } from "./state.js";
import { SaveStore, copyable } from "./store.js";
import {
	accepts, candidates, failoverCandidates, limitPct, mb, need, noRoom, offered, overLimit, room, roomable, usedPct,
	verdict, withinAvailable, type MemoryFacts,
} from "./targets.js";
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
	/** Memory amendment §3.6: false until balancer.json is loaded; room fails closed (MR11). */
	let accepting: (hostId: number) => boolean = () => false;
	const listeners = new Set<(instanceId: number) => void>();
	setBalancerApi({
		moving: id => mover?.moving(id) ?? false,
		accepts: id => accepting(id),
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
	/** Memory amendment §3.1: a tile's figure rose since the last pass, which then writes balancer.json (MR5). */
	let figuresRose = false;
	/** Memory amendment §3.2: each host's balancer.memory_limit_pct, as its HostMemoryEvent said (90 until then). */
	const limits = new Map<number, number>();
	/** MR-C1: each host's machine memory from its last HostMemoryEvent, bytes, `at` the controller's clock then. */
	const readings = new Map<number, { capacity: number; available: number; at: number }>();
	/** Capacity amendment C2: each host's core count from its last HostMemoryEvent. */
	const cores = new Map<number, number>();
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

	/** Capacity amendment C3: a host's cap while it stands; null: none, or expired. */
	const capOf = (hostId: number) => {
		const cap = state.hosts[hostId]?.cap;
		return cap && cap.until > Date.now() ? cap : null;
	};
	/** §5.8's view of the hosts. */
	const hostFacts = () => [...controller.hosts.values()].map(h => ({
		id: h.id,
		open: h.connected && !state.draining.includes(h.id),
		cores: cores.get(h.id) ?? null,
		cap: capOf(h.id)?.tiles ?? null,
	}));
	/** C2: the tiles of the unfinished moves to a host, but `id`'s own. */
	const arriving = (id: number) => (hostId: number) => state.moves
		.filter(m => !ended(m) && m.to === hostId && m.instanceId !== id).map(m => m.instanceId);

	/** Tier 1 of §5.8: the strict candidates for tile `id` on `from`. */
	const strict = (id: number, from: number | null, fits?: (hostId: number) => boolean) => candidates(
		from, hostFacts(), tiles(), i => telemetry.last(i), i => telemetry.meanMs(i),
		config.get("balancer.ups_floor"), fits, arriving(id),
	);

	/** Memory amendment §3.1–§3.3: what the memory rule reads now (MR1). */
	const memoryFacts = (): MemoryFacts => ({
		now: Date.now(),
		figures: state.memory,
		memory: h => readings.get(h),
		limits,
		tiles: tiles(),
		moves: state.moves,
		reserve: state.reserve,
	});
	/**
	 * Capacity amendment C5, C7 step 1: tile `id`, short of memory on the host, may be tested there and have room made:
	 * no reservation stands (there is one at most), and `roomable` over the host's empty tiles that have a target. The
	 * tile's own host is no target while it lags there (§5.8), so with two hosts none has one.
	 */
	const short = (f: MemoryFacts, id: number, hostId: number): boolean => state.reserve === undefined && roomable(
		f, id, hostId,
		tiles().filter(t => t.host === hostId && t.status === "running" && players(t.id) === 0 && port.hasCopy(t.id)
			&& !moves.moving(t.id) && port.candidates(t.id, hostId, "room", true).length > 0).map(t => t.id),
	);
	accepting = h => accepts(memoryFacts(), state.draining, h);

	const port: MoverPort = {
		now: Date.now,
		wait: ms => sleep(ms),
		candidates: (id, from, reason, runs, measure, tried = []) => {
			const floor = config.get("balancer.ups_floor");
			const f = memoryFacts();
			// Memory amendment §3.3–§3.4: a tile that will run on the target must fit there, for every reason; a
			// stopped tile's drain runs nothing (MR3). Capacity amendment C5: a measured tile may be short (`short`).
			const roomy = (h: number) => !runs || noRoom(f, id, h) === undefined
				|| (measure === true && short(f, id, h));
			// Capacity amendment C8: no host the tile is marked on, but as a failover's or a drain's last resort. Every
			// other reason, a `room` eviction (C7) too, never takes one; a move to a host the owner names asks no one.
			// The hosts the move has tried are out first: an errored pre-flight marks no bad pair (C46).
			const offer = (ranked: number[]) => offered(
				ranked.filter(h => !tried.includes(h)), h => `${id}:${h}` in state.marks,
				h => (state.bad[`${id}:${h}`] ?? 0) > f.now,
				reason === "failover" || reason === "drain",
			);
			if (reason === "failover") {
				const ranked = (fits?: (hostId: number) => boolean) => failoverCandidates(
					from, hostFacts(), tiles(), i => telemetry.last(i), i => telemetry.meanMs(i), floor,
					config.get("balancer.failover_floor"), fits, arriving(id),
				);
				const found = ranked(roomy);
				if (found.length === 0 && ranked().length > 0) {
					// M4: memory is a hard gate, best effort or not; the failover is tried again in 10 minutes (MR17).
					const rooms = hostFacts().filter(h => h.open && h.id !== from)
						.map(h => [h.id, mb(room(f, h.id, id))]);
					lifecycle(logger, "balancer.failover", "no_room", {
						instance: id, need_mb: mb(need(f.figures, id)), room_mb: Object.fromEntries(rooms),
					}, "warn");
				}
				return offer(found);
			}
			return offer(strict(id, from, roomy));
		},
		reserve: (id, hostId) => {
			if (state.reserve !== undefined) {
				return false;
			}
			state.reserve = { instanceId: id, host: hostId, until: Date.now() + RESERVE_MS };
			lifecycle(logger, "balancer.room", "reserved", { ...state.reserve });
			return true; // the move's end writes balancer.json
		},
		hostConnected: h => controller.hosts.get(h)?.connected ?? false,
		noRoom: (id, hostId) => noRoom(memoryFacts(), id, hostId),
		testable: (id, hostId) => withinAvailable(memoryFacts(), id, hostId),
		status: id => instance(id)?.status ?? "unknown",
		players,
		loadedSave: id => {
			const files = [...controller.saves.values()].filter(s => s.instanceId === id && copyable(s));
			return (files.find(s => s.loaded) ?? files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0])?.name;
		},
		saveMtime: (id, name) => [...controller.saves.values()].find(s => s.instanceId === id && s.name === name)
			?.mtimeMs,
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
			// A failover target outside tier 1 (a lagging or capped host) is judged on the emergency floor. Decided
			// before the run, whose own load can drop the host's tiles out of tier 1.
			const emergency = reason === "failover"
				&& !strict(id, inst.config.get("instance.assigned_host") ?? null).includes(hostId);
			const file = store.file(id);
			const stream = proxyStream(controller, { path: file, size: (await fs.stat(file)).size });
			const from = Date.now();
			try {
				// A release channel is resolved as Instance.fromConfig does; the host looks up the version it names.
				let version: string = inst.config.get("factorio.version");
				if (lib.isReleaseChannel(version)) {
					const resolved = lib.resolveReleaseChannel(await controller.latestReleases.get(), version);
					if (!resolved) {
						throw new Error(`cannot resolve Factorio release channel '${version}'`);
					}
					version = resolved;
				}
				const r = await controller.sendTo(
					{ hostId }, new PreflightRequest(id, stream.id, pack, version, PREFLIGHT_TICKS),
				);
				await sleep(SAMPLE_MS + 1_000);
				const running = tiles().filter(t => t.host === hostId && t.status === "running");
				const ups = running.flatMap(t => telemetry.minUps(t.id, from, Date.now()) ?? []);
				const minUps = ups.length > 0 ? Math.min(...ups) : null;
				// Capacity amendment C4: the ms line is the failover budget, whatever floor judges the target's tiles.
				const pass = verdict(
					r.msPerTick, minUps, 1000 / config.get("balancer.failover_floor"),
					config.get(emergency ? "balancer.failover_floor" : "balancer.ups_floor"), running.length > 0,
				);
				return { pass, msPerTick: r.msPerTick, minUps, tiles: running.length };
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
		start: async (id, name?) => {
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
			throw new lib.NotFoundError(`instance ${request.instanceId} does not exist`);
		}
		const from = inst.config.get("instance.assigned_host");
		const to = request.hostId;
		const refuse = (why: string) => new lib.ConflictError(`${inst.config.get("instance.name")} can't move: ${why}`);
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
		// Memory amendment §3.4 (M5, reversed by the owner, 2026-10-10): a manual move to a host without room goes
		// ahead with a warning. Failover and automatic moves stay strict.
		const why = to === undefined ? undefined : noRoom(memoryFacts(), inst.id, to);
		const m = moves.add({ instanceId: inst.id, from, to, reason: "manual", wasRunning: inst.status === "running" });
		if (why !== undefined) {
			lifecycle(logger, "balancer.move", "memory_override", { instance: inst.id, host: to, why }, "warn");
			return { moveId: m.id, warning: `${inst.config.get("instance.name")}: ${why}; moving anyway` };
		}
		return { moveId: m.id };
	});

	// §5.4: the operator's drain toggle. Drain runs whatever balancer.enabled says (P4).
	controller.handle(DrainRequest, async (request: DrainRequest) => {
		if (!controller.hosts.get(request.hostId)) {
			throw new lib.NotFoundError(`host ${request.hostId} does not exist`);
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

	// Capacity amendment C8: the owner clears one pair's mark, or all of a host's (a host since removed, too).
	controller.handle(ClearMarksRequest, async (request: ClearMarksRequest) => {
		const cleared = clearMarks(state.marks, request.hostId, request.instanceId);
		await persist();
		lifecycle(logger, "balancer.mark", "cleared", {
			host: request.hostId, instance: request.instanceId ?? null, cleared,
		});
		return { cleared };
	});

	controller.handle(HostMemoryEvent, async (event: HostMemoryEvent, src: lib.Address) => {
		readings.set(src.id, { capacity: event.capacity, available: event.available, at: Date.now() });
		if (event.cores !== undefined) {
			cores.set(src.id, event.cores);
		}
		if (limits.get(src.id) !== event.limitPct) {
			limits.set(src.id, event.limitPct);
			lifecycle(logger, "balancer.memory", "limit", { host: src.id, limit_pct: event.limitPct }); // MR18, K3
		}
	});

	controller.handle(StatusRequest, async (): Promise<Status> => {
		const f = memoryFacts();
		return {
			hosts: [...controller.hosts.values()].map(h => ({
				id: h.id,
				name: h.name,
				connected: h.connected,
				goneSinceMs: gone.has(h.id) ? wallOf(gone.get(h.id)!) : null,
				cores: cores.get(h.id) ?? null,
				cap: capOf(h.id),
				draining: state.draining.includes(h.id),
				usedPct: usedPct(f, h.id),
				limitPct: limitPct(f, h.id),
				room: room(f, h.id, null),
			})),
			tiles: [...controller.instances.values()].map(i => ({
				id: i.id,
				name: i.config.get("instance.name"),
				host: i.config.get("instance.assigned_host"),
				status: i.status,
				ups: telemetry.last(i.id)?.ups ?? null,
				ms: telemetry.meanMs(i.id) ?? null,
				mainMs: telemetry.meanMs(i.id, "mainMs") ?? null,
				players: players(i.id),
				// N2: pulledAt while mtime is 0
				copyMtimeMs: store.copy(i.id)?.mtimeMs || store.copy(i.id)?.pulledAt || null,
				need: need(f.figures, i.id),
			})),
			moves: state.moves,
			marks: Object.entries(state.marks).map(([key, mark]) => {
				const [instanceId, hostId] = key.split(":").map(Number);
				return { instanceId, hostId, mark };
			}),
			reserve: state.reserve ?? null,
		};
	});

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
			for (const key of Object.keys(state.marks).filter(k => k.startsWith(`${inst.id}:`))) {
				delete state.marks[key]; // C8: no expiry would clear them
			}
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
	/** Memory amendment §3.5: when a pass first saw each host over its memory limit. */
	const overSince = new Map<number, number>();
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
		// A move that failed after its assign left the tile stopped on its target: try its steps 4-6 there again.
		const again = stranded(tiles(), state.moves, now, RETRY_FAILED_MS, id => moves.moving(id), port.hasCopy);
		const add = (f: { instanceId: number; from: number; to?: number }): Add => ({
			instanceId: f.instanceId, from: f.from, reason: "failover",
			wasRunning: wasRunningBefore(f.instanceId, state.wasRunning, state.moves),
			...f.to === undefined ? {} : { to: f.to },
		});
		return [...move.map(add), ...again.map(add)];
	};

	/** What the decider reads (§4.3 unit 3): the cluster as it is now, `f` its memory; the pass sets memoryHigh. */
	const view = (f: MemoryFacts): View => ({
		now: f.now,
		connected: [...controller.hosts.values()].filter(h => h.connected).map(h => h.id),
		tiles: tiles().map(t => ({ ...t, players: players(t.id), hasCopy: port.hasCopy(t.id) })),
		moves: state.moves,
		draining: state.draining,
		telemetry,
		floor: config.get("balancer.ups_floor"),
		lagMs: config.get("balancer.lag_minutes") * 60_000,
		checkMs: config.get("balancer.after_check_minutes") * 60_000,
		fits: (id, h) => noRoom(f, id, h) === undefined,
		memoryHigh: [],
		figure: id => state.memory[id],
		marked: (id, h) => `${id}:${h}` in state.marks,
		bad: (id, h) => (state.bad[`${id}:${h}`] ?? 0) > f.now,
		short: (id, h) => short(f, id, h),
		reserve: state.reserve,
	});
	/**
	 * §5.6: record an after-check; a failed one marks its pair bad and may cap its host (C3), and the move may mark
	 * its origin or its target for cause (C8). Logged either way.
	 */
	const judge = (m: Move, check: Check) => {
		const badMs = config.get("balancer.bad_pair_hours") * 3_600_000;
		const floor = config.get("balancer.ups_floor");
		const cap = applyCheck(m, check, state, Date.now(), badMs, floor);
		const mark = markOf(m, check, floor);
		let outcome = "skipped";
		if (check.ok !== null) {
			outcome = check.ok ? "passed" : "failed";
		}
		lifecycle(logger, "balancer.check", outcome, {
			move: m.id, instance: m.instanceId, host: m.to, reason: m.reason, ups: check.ups, ms: check.ms,
			others_min_ups: check.othersMinUps, predicted_ms: m.preflight?.msPerTick ?? null,
			...(cap === undefined ? {} : { cap }),
			...(mark === undefined ? {} : { marked_host: mark.host, mark: mark.reason }),
		}, check.ok === false ? "warn" : "info");
		void persist();
	};

	// §4.3 unit 3, every 30 s. The first pass lets the mover start; it resumes the moves a restart interrupted as their
	// hosts reconnect, or after the grace (plan ruling 15, C43). The after-checks due are judged every pass; then the
	// first rule with work queues its moves (R1).
	const pass = () => {
		moves.resume();
		const f = memoryFacts();
		const v = view(f);
		// Memory amendment §3.5: the timers move at the pass. ponytail: a dip between passes is missed; watch
		// each HostMemoryEvent if 30 s ever matters.
		v.memoryHigh = memoryTimers(overSince, v.connected.filter(h => overLimit(f, h)), v.now, v.lagMs);
		for (const { move, check } of dueChecks(v)) {
			judge(move, check);
		}
		// P4: balancer.enabled gates failover, overload (its memory trigger too) and the after-check's re-move; drain
		// runs either way.
		const enabled = config.get("balancer.enabled");
		const d = decide(v, enabled ? failover() : [], enabled);
		if (d.release && state.reserve) { // capacity amendment C7: given up (step 5), arrived, or the pass was taken
			const { instanceId, host } = state.reserve;
			if (d.release === "bad") {
				state.bad[`${instanceId}:${host}`] = f.now + config.get("balancer.bad_pair_hours") * 3_600_000;
			}
			delete state.reserve;
			lifecycle(logger, "balancer.room", d.release === "bad" ? "gave_up" : "cleared", {
				instance: instanceId, host, rule: d.rule,
			}, d.release === "bad" ? "warn" : "info");
			void persist();
		}
		for (const a of d.add) {
			moves.add(a);
		}
		for (const b of d.beyond) {
			if (b.rule === "memory") {
				const fields = {
					op: "balancer.memory", phase: "no_move", host: b.host, used_pct: usedPct(f, b.host),
					limit_pct: limitPct(f, b.host),
				};
				const text = "balancer.memory no_move: over its memory limit, and no empty tile fits elsewhere";
				warn(`no_move:${b.host}`, text, fields);
			} else if (b.instance === null) { // C8
				const fields = { op: "balancer.overload", phase: "beyond", host: b.host, instance: null };
				const text = "balancer.overload beyond: a tile lags on the host, and no empty tile has a host to go to";
				warn(`beyond:host:${b.host}`, text, fields);
			} else {
				const fields = { op: "balancer.overload", phase: "beyond", host: b.host, instance: b.instance };
				const text = "balancer.overload beyond: its host's only lagging tile has no other open host to go to " +
					"(no room, marked or a bad pair)";
				warn(`beyond:${b.instance}`, text, fields);
			}
		}
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
