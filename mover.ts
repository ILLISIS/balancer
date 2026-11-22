import type { Move } from "./contracts.js";

/** A pre-flight's verdict; `tiles` is the target's running tiles then (capacity amendment C3's cap). */
export type PreflightResult = { pass: boolean; msPerTick: number | null; minUps: number | null; tiles: number };
export type MoverConfig = { maxConcurrent: number; badPairHours: number; graceMs: number };

/** What the mover needs from Clusterio: controller.ts implements it (Task 6), the tests fake it. */
export type MoverPort = {
	now(): number;
	/** The pause between retries of steps 4–6. */
	wait(ms: number): Promise<void>;
	/**
	 * Eligible targets, best first (§5.8 in phase 1); the mover drops the tried, bad and busy ones. `runs`: the tile
	 * will run on the target, so it must fit there in memory (memory amendment §3.4); false only for a stopped tile's
	 * drain. `measure` (capacity amendment C5): a host short of memory stays in when the tile's need is within its
	 * `available` bytes and room can be made there (C7 step 1). `tried`: the hosts the move has tried already, which
	 * are out before a last resort is decided (C8).
	 */
	candidates(
		instanceId: number, from: number | null, reason: Move["reason"], runs: boolean, measure?: boolean,
		tried?: number[],
	): number[];
	/**
	 * Capacity amendment C7 step 2: write the reservation of the host for the tile; false, and nothing written, when
	 * one stands already.
	 */
	reserve(instanceId: number, hostId: number): boolean;
	hostConnected(hostId: number): boolean;
	/** Memory amendment §3.3 (MR2): undefined when the instance fits on the host in memory; else why not. */
	noRoom(instanceId: number, hostId: number): string | undefined;
	/** C5: the tile's test copy fits the host's available bytes (the own-host run has no `noRoom`). */
	testable(instanceId: number, hostId: number): boolean;
	status(instanceId: number): string;
	players(instanceId: number): number;
	/** The save the running instance loaded, which its stop writes; else its newest file save. */
	loadedSave(instanceId: number): string | undefined;
	/** The mtime of the instance's save file on its host; undefined when it lists none. */
	saveMtime(instanceId: number, save: string): number | undefined;
	hasCopy(instanceId: number): boolean;
	/** §5.2 step 1 on the instance's stored copy; may throw: the next target is tried, no pair marked bad (C46). */
	preflight(instanceId: number, hostId: number, reason: Move["reason"]): Promise<PreflightResult>;
	tick(instanceId: number): Promise<number>;
	stop(instanceId: number): Promise<void>;
	/** Stop without saving: a stop would write the bad-tick game over the fresh copy (C27). */
	kill(instanceId: number): Promise<void>;
	/** Into the store: the copy becomes this save. */
	pull(instanceId: number, save: string): Promise<void>;
	assign(instanceId: number, hostId: number): Promise<void>;
	/** The stored copy into the instance's saves on its assigned host; returns the name stored. */
	push(instanceId: number): Promise<string>;
	/** No save named: the instance loads its newest. */
	start(instanceId: number, save?: string): Promise<void>;
	save(): Promise<void>;
	log(phase: string, move: Move, fields?: Record<string, unknown>, level?: "info" | "warn" | "error"): void;
	finished(move: Move): void;
};

/** §5.2: steps 4–6 are tried 3 times from the store before T goes back. */
const ATTEMPTS = 3;
const RETRY_MS = 10_000;
/** The ledger (§4.3 unit 4, R13): ended moves kept in balancer.json, each with its pre-flight and after-check. */
const KEEP_ENDED = 500;
/** Capacity amendment C5: results within 15 % of the lowest are a tie (benchmark runs of one save spread 7–13 %). */
const TIE = 0.15;
/** C5: the winner must be at least 30 % under the own host's result, which reads 10–17 % high on top of the spread. */
const OWN_MARGIN = 0.3;

export const ended = (m: Move) => m.step === "done" || m.step === "failed";

/**
 * The mover (§4.3 unit 2, §5.2). Every step is written to balancer.json before it runs, and each one is safe to repeat,
 * so a controller restart resumes from the last persisted step. One move per connected host at a time, as source or
 * target (a gone source doesn't count: plan ruling 7), and `maxConcurrent` in the cluster.
 */
export class Mover {
	private active = new Set<Move>();
	/** Nothing starts before resume(): the interrupted moves count against the limits first (C47). */
	private resumed = false;
	private loadedAt: number;
	/** Capacity amendment C5: each measured move's results so far, by host; not kept across a restart. */
	private results = new Map<Move, Map<number, PreflightResult>>();

	constructor(
		private moves: Move[],
		private bad: Record<string, number>,
		private port: MoverPort,
		private config: () => MoverConfig,
	) {
		this.loadedAt = port.now();
	}

	/** A move of the instance is queued or in progress (§4.5). */
	moving(instanceId: number): boolean {
		return this.moves.some(m => m.instanceId === instanceId && !ended(m));
	}

	/**
	 * Queue a move; it starts as soon as the limits allow. `to` names the operator's target (plan ruling 11), or the
	 * measured winner that now has room (capacity amendment C7 step 4). `measure`: C5's test.
	 */
	add(spec: {
		instanceId: number; from: number | null; to?: number; reason: Move["reason"]; wasRunning: boolean;
		measure?: boolean;
	}): Move {
		const now = this.port.now();
		const m: Move = {
			id: `${spec.instanceId}-${now}`,
			instanceId: spec.instanceId,
			from: spec.from,
			to: spec.to ?? null,
			reason: spec.reason,
			pinned: spec.to !== undefined,
			step: "queued",
			wasRunning: spec.wasRunning,
			tried: [],
			failures: 0,
			back: false,
			save: null,
			tick: null,
			startedAt: now,
			endedAt: null,
			error: null,
			preflight: null,
			check: null,
			...(spec.measure ? { measure: true } : {}),
		};
		this.moves.push(m);
		void this.port.save();
		this.port.log("queued", m);
		this.pump();
		return m;
	}

	/** Allow moves to start: the interrupted ones continue, the queued ones follow. Safe to call on every pass. */
	resume(): void {
		this.resumed = true;
		this.pump();
	}

	/**
	 * Continue every move that was in progress at the last stop, from its persisted step (§5.2), once the host its step
	 * talks to is connected (C43); after the failover grace the rest go anyway and fail into their usual path.
	 */
	private resumeWaiting(): void {
		const grace = this.port.now() - this.loadedAt >= this.config().graceMs;
		for (const m of this.moves.filter(x => !ended(x) && x.step !== "queued" && !this.active.has(x))) {
			const host = m.step === "stop" || m.step === "pull" ? m.from : m.to;
			// A stop also waits for the host's instance list: at connect T's status is still "unknown" (C43).
			const ready = host === null || (this.port.hostConnected(host)
				&& (m.step !== "stop" || this.port.status(m.instanceId) !== "unknown"));
			if (grace || ready) {
				this.port.log("resumed", m);
				this.run(m);
			}
		}
	}

	/** Start the queued moves the limits allow; called after each move ends and by the controller's 30 s pass. */
	pump(): void {
		if (!this.resumed) {
			return;
		}
		this.resumeWaiting();
		for (const m of this.moves.filter(x => x.step === "queued")) {
			if (this.active.size >= this.config().maxConcurrent) {
				return;
			}
			if ((m.from !== null && this.busy(m.from, m)) || (m.to !== null && this.busy(m.to, m))) {
				continue;
			}
			m.step = "preflight";
			this.run(m);
		}
	}

	/** A connected host in another active move, as its source or its target. */
	private busy(hostId: number, self: Move): boolean {
		if (!this.port.hostConnected(hostId)) {
			return false;
		}
		return [...this.active].some(a => a !== self && (a.from === hostId || a.to === hostId));
	}

	private run(m: Move): void {
		this.active.add(m);
		void (async () => {
			try {
				while (!ended(m) && m.step !== "queued") {
					await this.step(m);
				}
			} catch (err: any) {
				await this.end(m, "failed", `unexpected: ${err.message}`);
			}
			this.active.delete(m);
			if (ended(m)) {
				this.trim();
				this.port.finished(m);
				// A move put back in the queue waits for the next end or pass: re-pumping it here would spin.
				this.pump();
			}
		})();
	}

	private async step(m: Move): Promise<void> {
		if (m.step === "preflight") {
			return this.preflight(m);
		}
		if (m.step === "stop") {
			return this.stop(m);
		}
		if (m.step === "pull") {
			return this.pull(m);
		}
		try {
			if (m.step === "assign") {
				await this.port.assign(m.instanceId, m.to!);
				return await this.next(m, "push");
			}
			if (m.step === "push") {
				m.save = await this.port.push(m.instanceId);
				return await this.next(m, "start");
			}
			return await this.start(m);
		} catch (err: any) {
			return this.retry(m, err.message);
		}
	}

	/** A failover move assumes its source is gone; once it is connected again, the assign would stop a running tile. */
	private hostBack(m: Move): boolean {
		// A pinned retry of a tile stranded on its target has from === to: that host is meant to be connected.
		return m.reason === "failover" && m.from !== null && m.from !== m.to && this.port.hostConnected(m.from);
	}

	/** §5.2 step 1: the next target (or the named one), its pre-flight, and on a pass the next step. */
	private async preflight(m: Move): Promise<void> {
		const id = m.instanceId;
		if (this.hostBack(m)) {
			return this.end(m, "failed", "its host is back");
		}
		// §5.4, R12: a stopped tile leaves a draining host by steps 3–5: no pre-flight, and its pull makes the copy.
		const reassign = m.reason === "drain" && !m.wasRunning;
		if (!reassign && !this.port.hasCopy(id)) {
			return this.end(m, "failed", "no stored copy to pre-flight and move (plan ruling 6)");
		}
		if (m.measure) {
			return this.measure(m);
		}
		let to = m.to;
		if (to === null) {
			const now = this.port.now();
			// Memory amendment §3.4: a stopped tile's drain runs nothing on the target, so it needs no room (MR3).
			const left = this.port.candidates(id, m.from, m.reason, !reassign, false, m.tried)
				.filter(h => !m.tried.includes(h) && (this.bad[`${id}:${h}`] ?? 0) <= now);
			if (left.length === 0) {
				const why = m.tried.length > 0 ? "every target failed its pre-flight" : "no eligible target";
				return this.end(m, "failed", why);
			}
			const free = left.find(h => !this.busy(h, m));
			if (free === undefined) {
				m.step = "queued"; // every target left is in another move
				return undefined;
			}
			to = free;
			m.to = to;
		} else if (m.pinned) {
			// Memory amendment §3.4 (M5, reversed by the owner, 2026-10-10): the operator's host without room is
			// logged and the move goes on; the pre-flight and the after-check still decide. Capacity amendment C7
			// step 4: the measured winner is no operator's host, and without room its move ends.
			const why = this.port.noRoom(id, to);
			if (why !== undefined) {
				if (m.reason !== "manual") {
					return this.end(m, "failed", why);
				}
				this.port.log("memory_override", m, { why }, "warn");
			}
		}
		if (!m.tried.includes(to)) {
			m.tried.push(to);
		}
		if (reassign) {
			return this.next(m, "stop");
		}
		await this.port.save();
		this.port.log("preflight", m);
		let r: PreflightResult | undefined;
		try {
			r = await this.port.preflight(id, to, m.reason);
		} catch (err: any) {
			this.port.log("preflight_error", m, { error: err.message }, "warn");
		}
		const fields = { ms_per_tick: r?.msPerTick ?? null, min_ups: r?.minUps ?? null };
		if (r) { // the ledger (§4.3 unit 4)
			m.preflight = { msPerTick: r.msPerTick, minUps: r.minUps, tiles: r.tiles };
		}
		if (!r?.pass) {
			if (r) { // C46: an error is no verdict; only a measured fail marks the pair bad
				this.bad[`${id}:${to}`] = this.port.now() + this.config().badPairHours * 3_600_000;
			}
			this.port.log("preflight_failed", m, fields, "warn");
			if (m.pinned) {
				return this.end(m, "failed", `pre-flight failed on host ${to}`);
			}
			m.to = null;
			return this.port.save(); // the loop runs the pre-flight again, on the next target
		}
		this.port.log("preflight_passed", m, fields);
		return this.passed(m);
	}

	/** After a pass: a failover whose host came back meanwhile must not assign (it stops the tile there). */
	private async passed(m: Move): Promise<void> {
		if (this.hostBack(m)) {
			return this.end(m, "failed", "its host is back");
		}
		return this.next(m, m.reason === "failover" ? "assign" : "stop");
	}

	/**
	 * Capacity amendment C5: a host's only lagging tile is pre-flighted on its own host, where only the ms counts and
	 * no pair is marked, then on every candidate, one host each call; a candidate that fails is a bad pair, as in any
	 * pre-flight. With no candidate there is no test. After the last one, `settle`.
	 */
	private async measure(m: Move): Promise<void> {
		const id = m.instanceId;
		const own = m.from!;
		let got = this.results.get(m);
		if (!got) {
			got = new Map();
			this.results.set(m, got);
			m.tried = []; // a restart: the test runs again
		}
		const left = this.candidates(m).filter(h => !m.tried.includes(h));
		let to = own;
		if (m.tried.includes(own)) {
			if (left.length === 0) {
				return this.settle(m, got);
			}
			const free = left.find(h => !this.busy(h, m));
			if (free === undefined) {
				m.to = null;
				m.step = "queued"; // every candidate left is in another move
				return undefined;
			}
			to = free;
		} else if (left.length === 0) {
			this.results.delete(m);
			return this.end(m, "failed", "no eligible target");
		}
		if (to === own && !this.port.testable(id, own)) {
			this.results.delete(m);
			return this.end(m, "failed", "no memory to test it on its own host");
		}
		m.to = to;
		m.tried.push(to);
		await this.port.save();
		this.port.log("preflight", m);
		let r: PreflightResult | undefined;
		try {
			r = await this.port.preflight(id, to, m.reason);
		} catch (err: any) {
			this.port.log("preflight_error", m, { error: err.message }, "warn");
		}
		const fields = { ms_per_tick: r?.msPerTick ?? null, min_ups: r?.minUps ?? null };
		m.to = null;
		if (to === own) {
			if (r?.msPerTick === null || r === undefined) {
				this.results.delete(m);
				return this.end(m, "failed", "the pre-flight on its own host gave no result");
			}
			got.set(own, r);
			this.port.log("preflight_measured", m, { host: own, ...fields });
		} else if (r?.pass && r.msPerTick !== null) {
			got.set(to, r);
			this.port.log("preflight_passed", m, { host: to, ...fields });
		} else {
			if (r) { // C46
				this.bad[`${id}:${to}`] = this.port.now() + this.config().badPairHours * 3_600_000;
			}
			this.port.log("preflight_failed", m, { host: to, ...fields }, "warn");
		}
		return this.port.save(); // the loop runs the next host's test
	}

	/** A measured move's candidates now, in C2's order, but the bad pairs. */
	private candidates(m: Move): number[] {
		const now = this.port.now();
		return this.port.candidates(m.instanceId, m.from, m.reason, true, true)
			.filter(h => (this.bad[`${m.instanceId}:${h}`] ?? 0) <= now);
	}

	/**
	 * Capacity amendment C5: the measured winner: the lowest ms among the candidates that passed and are candidates
	 * still, or the first in C2's order within `TIE` of it. The tile moves there only if that is `OWN_MARGIN` under its
	 * own host's result. C7: a winner short of memory is reserved and the move ends "needs room" with no bad pair
	 * (step 2); one that can't be reserved is dropped and the next result is taken (step 1). When its own host wins,
	 * or no host is under the line, nothing moves and every candidate tested is a bad pair: the test repeats at most
	 * once in `badPairHours`.
	 */
	private async settle(m: Move, got: Map<number, PreflightResult>): Promise<void> {
		const id = m.instanceId;
		const own = m.from!;
		this.results.delete(m);
		const ms = (h: number) => got.get(h)!.msPerTick!;
		const passed = this.candidates(m).filter(h => got.has(h));
		let why = passed.length > 0 ? "its own host measured best (C5)" : "no host measured under the line (C5)";
		while (passed.length > 0) {
			const lowest = Math.min(...passed.map(ms));
			const winner = passed.find(h => ms(h) <= lowest * (1 + TIE))!;
			if (ms(winner) > ms(own) * (1 - OWN_MARGIN)) {
				break;
			}
			if (this.port.noRoom(id, winner) === undefined) {
				if (this.busy(winner, m)) { // free between the tests, so another move may have taken it
					this.results.set(m, got);
					m.step = "queued";
					return undefined;
				}
				m.to = winner;
				m.preflight = (({ msPerTick, minUps, tiles }) => ({ msPerTick, minUps, tiles }))(got.get(winner)!);
				return this.next(m, "stop");
			}
			if (this.port.reserve(id, winner)) {
				return this.end(m, "failed", `needs room on host ${winner}`);
			}
			why = `no room can be made on host ${winner} (C7)`;
			passed.splice(passed.indexOf(winner), 1);
		}
		const until = this.port.now() + this.config().badPairHours * 3_600_000;
		// The candidates that measured (passed but lost). A failed verdict is marked in measure(); a pre-flight that
		// threw gave no verdict, so it isn't held against the host (C46).
		for (const h of m.tried.filter(x => x !== own && got.has(x))) {
			this.bad[`${id}:${h}`] = until;
		}
		return this.end(m, "failed", why);
	}

	/** §5.2 step 2. B4: a player who joined since the move was accepted ends it here, before anything stops. */
	private async stop(m: Move): Promise<void> {
		const id = m.instanceId;
		if (this.port.status(id) !== "stopped") {
			m.save = this.port.loadedSave(id) ?? null;
			if (m.save === null) {
				return this.end(m, "failed", "the running tile lists no save to pull");
			}
			m.tick = await this.port.tick(id);
			await this.port.save();
			if (this.port.players(id) > 0) { // C22: as late as possible, so a player who just joined isn't kicked
				return this.end(m, "failed", "players are on the tile: only empty tiles move (B4)");
			}
			const before = this.port.saveMtime(id, m.save);
			try {
				await this.port.stop(id);
			} catch (err: any) {
				// C8: if it stopped before throwing, the tile would silently stay down.
				if (m.wasRunning && this.port.status(id) === "stopped") {
					await this.port.start(id, m.save).catch((e: Error) => {
						this.port.log("restart_failed", m, { error: e.message }, "error");
					});
				}
				return this.end(m, "failed", `stop failed: ${err.message}`);
			}
			// A stop that ends in a kill (Clusterio's shutdown timeout) resolves with no save written: the file is
			// stale, and pulling it would replace the stored copy. T starts again on its newest save.
			if ((this.port.saveMtime(id, m.save) ?? 0) <= (before ?? 0)) {
				if (m.wasRunning) {
					await this.port.start(id).catch((e: Error) => {
						this.port.log("restart_failed", m, { error: e.message }, "error");
					});
				}
				return this.end(m, "failed", `the stop wrote no ${m.save}`);
			}
		}
		m.save ??= this.port.loadedSave(id) ?? null;
		if (m.save === null) {
			if (m.reason === "drain" && !m.wasRunning) { // never started: no save to pull, so only the assignment moves
				try {
					await this.port.assign(id, m.to!);
				} catch (err: any) {
					return this.end(m, "failed", `assign failed: ${err.message}`);
				}
				return this.end(m, "done");
			}
			return this.end(m, "failed", "no save to pull");
		}
		return this.next(m, "pull");
	}

	/** §5.2 step 3; if it fails, T starts again on S. */
	private async pull(m: Move): Promise<void> {
		try {
			await this.port.pull(m.instanceId, m.save!);
		} catch (err: any) {
			if (m.wasRunning) {
				await this.port.start(m.instanceId, m.save!).catch((e: Error) => {
					this.port.log("restart_failed", m, { error: e.message }, "error");
				});
			}
			return this.end(m, "failed", `pull failed: ${err.message}`);
		}
		return this.next(m, "assign");
	}

	/** §5.2 step 6: start with the pushed save named, and check it loaded the stopped tick or later. */
	private async start(m: Move): Promise<void> {
		const id = m.instanceId;
		if (m.wasRunning) {
			if (this.port.status(id) !== "running") {
				await this.port.start(id, m.save!);
			}
			if (m.tick !== null) {
				const tick = await this.port.tick(id);
				if (tick < m.tick) {
					// C23/C27: killed (no save), so the retry's start loads the re-pushed copy.
					await this.port.kill(id);
					throw new Error(`it loaded tick ${tick}, before the saved ${m.tick}`);
				}
			}
		}
		return this.end(m, "done", m.back ? m.error : null);
	}

	/** §5.2: steps 4–6 retry from the store; after 3 failures T goes back to S with the same copy, once. */
	private async retry(m: Move, error: string): Promise<void> {
		m.failures += 1;
		this.port.log("retry", m, { error, failures: m.failures }, "warn");
		if (m.failures < ATTEMPTS) {
			m.step = "assign";
			await this.port.save();
			return this.port.wait(RETRY_MS);
		}
		// C21: an unknown status may be a copy still running on H; going back would start a second one (§5.3 decides).
		if (
			!m.back && m.from !== null && m.from !== m.to && this.port.hostConnected(m.from)
			&& this.port.status(m.instanceId) !== "unknown"
		) {
			m.back = true;
			m.error = error; // C13: the done that follows shows why the tile came back
			m.to = m.from;
			m.failures = 0;
			m.step = "assign";
			await this.port.save();
			this.port.log("back", m, { error }, "warn");
			return undefined;
		}
		return this.end(m, "failed", error);
	}

	private async next(m: Move, step: Move["step"]): Promise<void> {
		m.step = step;
		await this.port.save();
		this.port.log(step, m);
	}

	private async end(m: Move, step: "done" | "failed", error: string | null = null): Promise<void> {
		m.step = step;
		m.error = error;
		m.endedAt = this.port.now();
		await this.port.save();
		this.port.log(step, m, error === null ? {} : { error }, step === "done" ? "info" : "warn");
	}

	/** Keep every unfinished move and the last KEEP_ENDED ended ones. */
	private trim(): void {
		const done = this.moves.filter(ended);
		for (const old of done.slice(0, Math.max(0, done.length - KEEP_ENDED))) {
			this.moves.splice(this.moves.indexOf(old), 1);
		}
	}
}
