import type { Move } from "./contracts.js";

export type PreflightResult = { pass: boolean; msPerTick: number | null; minUps: number | null };
export type MoverConfig = { maxConcurrent: number; badPairHours: number; graceMs: number };

/** What the mover needs from Clusterio: controller.ts implements it (Task 6), the tests fake it. */
export type MoverPort = {
	now(): number;
	/** The pause between retries of steps 4–6. */
	wait(ms: number): Promise<void>;
	/** Eligible targets, best first (§5.8 in phase 1); the mover drops the tried, bad and busy ones. */
	candidates(instanceId: number, from: number | null): number[];
	hostConnected(hostId: number): boolean;
	status(instanceId: number): string;
	players(instanceId: number): number;
	/** The save the running instance loaded, which its stop writes; else its newest file save. */
	loadedSave(instanceId: number): string | undefined;
	hasCopy(instanceId: number): boolean;
	/** §5.2 step 1 on the instance's stored copy; may throw: the next target is tried, no pair marked bad (C46). */
	preflight(instanceId: number, hostId: number): Promise<PreflightResult>;
	tick(instanceId: number): Promise<number>;
	stop(instanceId: number): Promise<void>;
	/** Stop without saving: a stop would write the bad-tick game over the fresh copy (C27). */
	kill(instanceId: number): Promise<void>;
	/** Into the store: the copy becomes this save. */
	pull(instanceId: number, save: string): Promise<void>;
	assign(instanceId: number, hostId: number): Promise<void>;
	/** The stored copy into the instance's saves on its assigned host; returns the name stored. */
	push(instanceId: number): Promise<string>;
	start(instanceId: number, save: string): Promise<void>;
	save(): Promise<void>;
	log(phase: string, move: Move, fields?: Record<string, unknown>, level?: "info" | "warn" | "error"): void;
	finished(move: Move): void;
};

/** §5.2: steps 4–6 are tried 3 times from the store before T goes back. */
const ATTEMPTS = 3;
const RETRY_MS = 10_000;
/** Ended moves kept in balancer.json for the page and ctl. ponytail: phase 2's ledger keeps 500 with outcomes. */
const KEEP_ENDED = 50;

const ended = (m: Move) => m.step === "done" || m.step === "failed";

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

	/** Queue a move; it starts as soon as the limits allow. `to` names the operator's target (plan ruling 11). */
	add(
		spec: { instanceId: number; from: number | null; to?: number; reason: Move["reason"]; wasRunning: boolean },
	): Move {
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
			if (grace || host === null || this.port.hostConnected(host)) {
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

	/** §5.2 step 1: the next target (or the named one), its pre-flight, and on a pass the next step. */
	private async preflight(m: Move): Promise<void> {
		const id = m.instanceId;
		if (!this.port.hasCopy(id)) {
			return this.end(m, "failed", "no stored copy to pre-flight and move (plan ruling 6)");
		}
		let to = m.to;
		if (to === null) {
			const now = this.port.now();
			const left = this.port.candidates(id, m.from)
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
		}
		if (!m.tried.includes(to)) {
			m.tried.push(to);
		}
		await this.port.save();
		this.port.log("preflight", m);
		let r: PreflightResult | undefined;
		try {
			r = await this.port.preflight(id, to);
		} catch (err: any) {
			this.port.log("preflight_error", m, { error: err.message }, "warn");
		}
		const fields = { ms_per_tick: r?.msPerTick ?? null, min_ups: r?.minUps ?? null };
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
		return this.next(m, m.reason === "failover" ? "assign" : "stop");
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
		}
		m.save ??= this.port.loadedSave(id) ?? null;
		if (m.save === null) {
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
