import { RESERVE_MS, type Check, type Mark, type Move, type Reserve } from "./contracts.js";
import { RETRY_FAILED_MS } from "./failover.js";
import { ended } from "./mover.js";
import type { State } from "./state.js";
import { KEEP_MS, type Telemetry } from "./telemetry.js";

/** §5.5: at most one overload move per host in this long; memory moves share it (memory amendment §3.5). */
const OVERLOAD_EVERY_MS = 600_000;
/** S4: a draining host with no eligible target is left alone this long. */
const NO_TARGET_MS = 600_000;

/**
 * A move the decider asks for: Mover.add's argument. `measure`: capacity amendment C5's test; `to`: the measured winner
 * that now has room, pinned (C7 step 4).
 */
export type Add = {
	instanceId: number; from: number; reason: Move["reason"]; wasRunning: boolean; measure?: true; to?: number;
};
export type Tile = { id: number; host: number | null; status: string; players: number; hasCopy: boolean };
/**
 * Named, not moved: a host's only lagging tile with no host to go to (§5.5, capacity amendment C5), or, with
 * `instance` null, a host with a lagging tile (rule overload, capacity amendment C8) or over its memory limit (rule
 * memory, memory amendment §3.5, MR7) and no empty tile that has a host to go to.
 */
export type Beyond = { host: number; instance: number | null; rule: "overload" | "memory" };
/** What the decider reads (§4.3 unit 3); the controller builds it each pass, the tests and the bench by hand. */
export type View = {
	now: number;
	connected: number[];
	tiles: Tile[];
	moves: Move[];
	draining: number[];
	telemetry: Telemetry;
	floor: number;
	lagMs: number;
	checkMs: number;
	/** Memory amendment §3.3: instance T fits on host H in memory. */
	fits: (instanceId: number, hostId: number) => boolean;
	/** §3.5: the hosts over their memory limit for lagMs or longer (memoryTimers); the controller's pass sets it. */
	memoryHigh: number[];
	/** §3.1: a tile's memory figure, bytes; undefined: none yet. */
	figure: (instanceId: number) => number | undefined;
	/** Capacity amendment C8: the tile is marked on the host. */
	marked: (instanceId: number, hostId: number) => boolean;
	/** §5.6: the pair is bad now. */
	bad: (instanceId: number, hostId: number) => boolean;
	/**
	 * Capacity amendment C5, C7 step 1: the tile, short of memory on the host, may be pre-flighted there and have room
	 * made (`roomable`). Absent: never.
	 */
	short?: (instanceId: number, hostId: number) => boolean;
	/** C7: the reservation, if one is written. */
	reserve?: Reserve;
};
/**
 * `release` (capacity amendment C7): the reservation goes; "bad": given up, so its pair is bad for `bad_pair_hours`;
 * "clear": the tile arrived, or a failover or a drain took the pass with a move under way.
 */
export type Decision = { rule: Move["reason"] | null; add: Add[]; beyond: Beyond[]; release?: "bad" | "clear" };

/**
 * Capacity amendment C8: a tile on `h` has a host to go to: connected, not `h` nor `not`, not draining, not a bad pair,
 * with room for it if it runs, and one it isn't marked on, unless marked hosts count (`lastResort`: a drain).
 * `measure` (C5): a host short of memory counts where the tile can be tested and room made (`View.short`).
 */
const goes = (
	v: View, t: Tile, h: number, opt: { lastResort?: boolean; measure?: boolean; not?: number } = {},
) => v.connected.some(o => o !== h && o !== opt.not
	&& !v.draining.includes(o) && !v.bad(t.id, o) && (opt.lastResort || !v.marked(t.id, o))
	&& (t.status !== "running" || v.fits(t.id, o) || (opt.measure === true && v.short?.(t.id, o) === true)));
const moving = (v: View, id: number) => v.moves.some(m => m.instanceId === id && !ended(m));
const failedLately = (v: View, id: number, reason: Move["reason"]) => v.moves.some(m => m.instanceId === id
	&& m.reason === reason && (m.step === "failed" || m.back) && v.now - (m.endedAt ?? 0) < RETRY_FAILED_MS);

/**
 * §4.3 unit 3, R1: the first rule with work takes the pass: failover (its moves found by the controller), drain,
 * overload (its memory trigger first: memory amendment §3.5, MR8), then the after-check's re-moves.
 * A rule has work when it asks for moves now or one of its moves is unfinished. P4: disabled, only drain runs,
 * and `failover` comes empty. Capacity amendment C7: a reservation holds the overload rule's place, and a failover or
 * a drain that takes the pass clears it, once one of its moves is unfinished.
 */
export function decide(v: View, failover: Add[], enabled: boolean): Decision {
	const unfinished = (rule: Move["reason"]) => v.moves.some(m => m.reason === rule && !ended(m));
	const holds = (rule: Move["reason"], add: Add[]) => add.length > 0 || unfinished(rule);
	// Only a move under way clears it: one asked for this pass may fail at once, and so would its retries.
	const freed = (rule: Move["reason"]) => (v.reserve && unfinished(rule) ? { release: "clear" as const } : {});
	if (enabled && holds("failover", failover)) {
		return { rule: "failover", add: failover, beyond: [], ...freed("failover") };
	}
	const drain = drainMoves(v);
	if (holds("drain", drain)) {
		return { rule: "drain", add: drain, beyond: [], ...freed("drain") };
	}
	if (!enabled) {
		return { rule: null, add: [], beyond: [] };
	}
	const overload = overloadMoves(v);
	// Memory amendment §3.5: memory moves are §5.5's second trigger, in its slot (MR8).
	if (v.reserve || holds("overload", overload.add) || holds("memory", []) || holds("room", [])) {
		return { rule: "overload", ...overload };
	}
	const recheck = recheckMoves(v);
	return { rule: holds("after_check", recheck) ? "after_check" : null, add: recheck, beyond: overload.beyond };
}

/**
 * §5.4, R12: per connected draining host with no drain move under way, its first tile that can go: running and empty
 * with a copy (the pre-flight needs one), or stopped. Occupied tiles wait; a tile whose drain move failed waits 10
 * minutes; a tile with no host to go to (`goes`; a marked host counts, capacity amendment C8) is passed over, so the
 * drain doesn't stop behind it.
 */
export function drainMoves(v: View): Add[] {
	const add: Add[] = [];
	for (const h of v.draining) {
		const drains = v.moves.filter(m => m.reason === "drain" && m.from === h);
		const last = drains.at(-1);
		if (
			!v.connected.includes(h) || drains.some(m => !ended(m))
			|| (last?.step === "failed" && last.error === "no eligible target"
				&& v.now - (last.endedAt ?? 0) < NO_TARGET_MS)
		) {
			continue;
		}
		const t = v.tiles.find(x => x.host === h && !moving(v, x.id) && !failedLately(v, x.id, "drain")
			&& ((x.status === "running" && x.players === 0 && x.hasCopy) || x.status === "stopped")
			&& goes(v, x, h, { lastResort: true }));
		if (t) {
			add.push({ instanceId: t.id, from: h, reason: "drain", wasRunning: t.status === "running" });
		}
	}
	return add;
}

/**
 * §5.5, R16: per connected host with a tile lagging (Telemetry.lagging), its heaviest empty tile with a copy moves, at
 * most once per host per 10 minutes. Heaviest: by main-thread CPU ms per tick, or over all threads where a tile has no
 * main-thread reading (capacity amendment C5, C9). A host's only lagging tile moves itself when it is empty; when it
 * has no host to go to (`goes`: M6, capacity amendment C8) it is beyond that host: named in `beyond`, not moved.
 * Either pick is of the tiles with a host to go to, so one stuck tile isn't picked again every 10 minutes (C8); with
 * none, the host is named in `beyond` with instance null.
 * Memory amendment §3.5 (M8) comes first: a host over its memory limit for lagMs moves its empty tile with a copy that
 * has the largest figure (none counts as 0) and a host to go to, with reason memory, under the same 10-minute limit;
 * with none, the host is named in `beyond` with instance null and rule memory. Either way it gets no lag move that
 * pass (MR10).
 * Capacity amendment C5: the lone tile's move is a measurement (`measure`), and a host short of memory where it can be
 * tested and room made is a host to go to. C7: while a reservation stands, its moves are the pass's (`reserved`).
 */
export function overloadMoves(v: View): { add: Add[]; beyond: Beyond[]; release?: "bad" | "clear" } {
	if (v.reserve) {
		return { beyond: [], ...reserved(v, v.reserve) };
	}
	const add: Add[] = [];
	const beyond: Beyond[] = [];
	const ms = (id: number) => v.telemetry.meanMs(id, "mainMs") ?? v.telemetry.meanMs(id) ?? -1;
	for (const h of v.connected) {
		const running = v.tiles.filter(t => t.host === h && t.status === "running");
		const limited = v.moves.some(m => (m.reason === "overload" || m.reason === "memory") && m.from === h
			&& (!ended(m) || v.now - m.startedAt < OVERLOAD_EVERY_MS));
		if (v.memoryHigh.includes(h)) {
			if (!limited) {
				const [largest] = running.filter(t => t.players === 0 && t.hasCopy && !moving(v, t.id) && goes(v, t, h))
					.sort((a, b) => (v.figure(b.id) ?? 0) - (v.figure(a.id) ?? 0));
				if (largest) {
					add.push({ instanceId: largest.id, from: h, reason: "memory", wasRunning: true });
				} else {
					beyond.push({ host: h, instance: null, rule: "memory" });
				}
			}
			continue;
		}
		const lagging = running.filter(t => v.telemetry.lagging(t.id, v.floor, v.lagMs));
		if (lagging.length === 0) {
			continue;
		}
		const empty = running.filter(t => t.players === 0 && t.hasCopy && !moving(v, t.id));
		const lone = lagging.length === 1 && empty.includes(lagging[0]);
		if (lone && !goes(v, lagging[0], h, { measure: true })) {
			beyond.push({ host: h, instance: lagging[0].id, rule: "overload" });
			continue;
		}
		if (limited) {
			continue;
		}
		const [pick] = lone ? lagging : empty.filter(t => goes(v, t, h)).sort((a, b) => ms(b.id) - ms(a.id));
		if (pick) {
			const measure = lone ? { measure: true as const } : {}; // C5
			add.push({ instanceId: pick.id, from: h, reason: "overload", wasRunning: true, ...measure });
		} else {
			beyond.push({ host: h, instance: null, rule: "overload" });
		}
	}
	return { add, beyond };
}

/**
 * Capacity amendment C7 steps 3–5: the pass's work for the reservation of W for T, the measured winner T doesn't fit
 * on. Released as `bad` (given up; evicted tiles stay where they landed) when W is closed, T is occupied, isn't running
 * or no longer lags (a move that changed its host dropped its samples, so that is covered), the 30 minutes have
 * passed, or T's pinned move ended without bringing it to W; as `clear` when T runs on W. Else nothing while a move of
 * T or a `room` move off W is under way (T "fits" once the evicted tile has stopped, but that move may yet fail and
 * bring it back); once T fits, its move pinned to W (step 4); until then one `room` move off W: its empty
 * tile with a copy and the largest memory figure that has a host to go to, T's own host aside (ineligible while T
 * lags there, so with two hosts nothing is evicted), and whose `room` move didn't fail lately. Exempt from the
 * 10-minute limit.
 */
function reserved(v: View, r: Reserve): { add: Add[]; release?: "bad" | "clear" } {
	const t = v.tiles.find(x => x.id === r.instanceId);
	if (t?.host === r.host) {
		return { add: [], release: "clear" };
	}
	if (t && moving(v, t.id)) {
		return { add: [] };
	}
	if (
		!t || t.host === null || !v.connected.includes(r.host) || v.draining.includes(r.host) || t.players > 0
		|| t.status !== "running" || v.now >= r.until || !v.telemetry.lagging(t.id, v.floor, v.lagMs)
		|| v.moves.some(m => m.instanceId === t.id && m.pinned && m.reason === "overload"
			&& m.startedAt >= r.until - RESERVE_MS)
	) {
		return { add: [], release: "bad" };
	}
	const own = t.host;
	if (v.moves.some(m => m.reason === "room" && m.from === r.host && !ended(m))) {
		return { add: [] };
	}
	if (v.fits(t.id, r.host)) {
		return { add: [{ instanceId: t.id, from: own, to: r.host, reason: "overload", wasRunning: true }] };
	}
	const [largest] = v.tiles
		.filter(x => x.host === r.host && x.status === "running" && x.players === 0 && x.hasCopy && !moving(v, x.id)
			&& !failedLately(v, x.id, "room") && goes(v, x, r.host, { not: own }))
		.sort((a, b) => (v.figure(b.id) ?? 0) - (v.figure(a.id) ?? 0));
	return { add: largest ? [{ instanceId: largest.id, from: r.host, reason: "room", wasRunning: true }] : [] };
}

/**
 * §5.6, R9, R15: the done moves due for their after-check: the move ran the tile, wasn't a failover (§5.3 runs steps 1
 * and 4–6) or a way back, and ended after_check_minutes ago. Judged on the last 5 minutes before it: T's mean UPS on
 * the target at the floor or above, and the mean UPS of each of the target's other running tiles too (capacity
 * amendment C6; one with no sample in the window is skipped). Not judged (ok null) when T no longer runs there or has
 * no sample.
 */
export function dueChecks(v: View): { move: Move; check: Check }[] {
	const due: { move: Move; check: Check }[] = [];
	for (const m of v.moves) {
		if (
			m.step !== "done" || m.check !== null || !m.wasRunning || m.back || m.reason === "failover"
			|| m.to === null || m.endedAt === null || v.now < m.endedAt + v.checkMs
			|| v.now > m.endedAt + v.checkMs + KEEP_MS // M2: the window is gone (a migrated move, a controller outage)
		) {
			continue;
		}
		const from = Math.max(m.endedAt, v.now - KEEP_MS);
		const t = v.tiles.find(x => x.id === m.instanceId);
		const mine = t?.host === m.to && t.status === "running" ? v.telemetry.mean(t.id, from, v.now) : undefined;
		const lows = mine === undefined ? [] : v.tiles
			.filter(x => x.host === m.to && x.status === "running" && x.id !== m.instanceId)
			.flatMap(x => v.telemetry.mean(x.id, from, v.now)?.ups ?? []);
		const othersMinUps = lows.length > 0 ? Math.min(...lows) : null;
		const ok = mine === undefined
			? null : mine.ups >= v.floor && (othersMinUps === null || othersMinUps >= v.floor);
		due.push({ move: m, check: { at: v.now, ups: mine?.ups ?? null, ms: mine?.ms ?? null, othersMinUps, ok } });
	}
	return due;
}

/**
 * Capacity amendment C8: the mark a judged move writes, if any. Its origin, for an overload move (the tile lagged
 * there, or was shed as the heaviest empty one) whose check passed or was skipped: a failed check can still send the
 * tile back. Its target, for any move, when the tile's own mean was under `floor` there; a check that failed only
 * because the other tiles slowed marks nothing. A memory move, a drain, a failover and the owner's move mark no
 * origin; nor will a `room` eviction (C7).
 */
export function markOf(m: Move, check: Check, floor: number): { host: number; reason: Mark["reason"] } | undefined {
	if (check.ok === false) {
		return m.to !== null && check.ups !== null && check.ups < floor ? { host: m.to, reason: "slow" } : undefined;
	}
	return m.reason === "overload" && m.from !== null ? { host: m.from, reason: "overload" } : undefined;
}

/**
 * §5.6, R10: record the after-check on its move, and its mark (`markOf`, capacity amendment C8). A failed one marks
 * (T, H) bad, and, when H's other tiles slowed below `floor` (S3), caps H for `badPairMs` at the tiles it ran when T's
 * pre-flight passed there (capacity amendment C3); while a cap stands, the lower count is kept. Returns H's cap when
 * it set one.
 */
export function applyCheck(
	m: Move, check: Check, s: Pick<State, "bad" | "hosts" | "marks">, now: number, badPairMs: number, floor: number,
): number | undefined {
	m.check = check;
	const mark = markOf(m, check, floor);
	if (mark) {
		s.marks[`${m.instanceId}:${mark.host}`] = { reason: mark.reason, at: now };
	}
	if (check.ok !== false || m.to === null) {
		return undefined;
	}
	s.bad[`${m.instanceId}:${m.to}`] = now + badPairMs;
	const tiles = m.preflight?.tiles;
	if (tiles === undefined || check.othersMinUps === null || check.othersMinUps >= floor) {
		return undefined;
	}
	s.hosts[m.to] ??= {};
	const h = s.hosts[m.to];
	h.cap = { tiles: h.cap && h.cap.until > now ? Math.min(tiles, h.cap.tiles) : tiles, until: now + badPairMs };
	return h.cap.tiles;
}

/**
 * Capacity amendment C8: the owner clears the mark of `instanceId` on `hostId`, or with no instance all of that
 * host's. Returns how many went.
 */
export function clearMarks(marks: State["marks"], hostId: number, instanceId?: number): number {
	const keys = Object.keys(marks).filter(key => {
		const [i, h] = key.split(":").map(Number);
		return h === hostId && (instanceId === undefined || i === instanceId);
	});
	for (const key of keys) {
		delete marks[key];
	}
	return keys.length;
}

/**
 * §5.6: a failed after-check moves T again once it's empty, back or to the next best target (the mover ranks; the pair
 * is bad now): only while that move is T's latest and T still runs on its target, so it is tried once.
 */
export function recheckMoves(v: View): Add[] {
	const add: Add[] = [];
	for (const m of v.moves) {
		if (m.check?.ok !== false) {
			continue;
		}
		const latest = v.moves.filter(x => x.instanceId === m.instanceId).at(-1);
		const t = v.tiles.find(x => x.id === m.instanceId);
		if (
			latest === m && t && m.to !== null && t.host === m.to && t.status === "running" && t.players === 0
			&& t.hasCopy
		) {
			add.push({ instanceId: t.id, from: t.host, reason: "after_check", wasRunning: true });
		}
	}
	return add;
}

/**
 * Memory amendment §3.5: keep `since` (host → when a pass first saw it over its memory limit) current: each host in
 * `over` keeps its time or starts one now, and every other host's is cleared (at or under its limit, or a stale or
 * missing reading). Returns the hosts over their limit for `lagMs` or longer.
 */
export function memoryTimers(since: Map<number, number>, over: number[], now: number, lagMs: number): number[] {
	for (const h of since.keys()) {
		if (!over.includes(h)) {
			since.delete(h);
		}
	}
	for (const h of over) {
		if (!since.has(h)) {
			since.set(h, now);
		}
	}
	return over.filter(h => now - since.get(h)! >= lagMs);
}
