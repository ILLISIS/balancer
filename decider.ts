import type { Check, Move } from "./contracts.js";
import { RETRY_FAILED_MS } from "./failover.js";
import { ended } from "./mover.js";
import type { HostState, State } from "./state.js";
import { predictedMs } from "./targets.js";
import { KEEP_MS, type Telemetry } from "./telemetry.js";

/** §5.5: at most one overload move per host in this long. */
const OVERLOAD_EVERY_MS = 600_000;
/** S4: a draining host with no eligible target is left alone this long. */
const NO_TARGET_MS = 600_000;

/** A move the decider asks for: Mover.add's argument. */
export type Add = { instanceId: number; from: number; reason: Move["reason"]; wasRunning: boolean };
export type Tile = { id: number; host: number | null; status: string; players: number; hasCopy: boolean };
/** What the decider reads (§4.3 unit 3); the controller builds it each pass, the tests and the bench by hand. */
export type View = {
	now: number;
	connected: number[];
	tiles: Tile[];
	moves: Move[];
	draining: number[];
	benchmarking: Set<number>;
	telemetry: Telemetry;
	/** A host's benchmark speed, null: none. */
	speed: (hostId: number) => number | null;
	floor: number;
	busyMs: number;
	lagMs: number;
	checkMs: number;
};
export type Decision = { rule: Move["reason"] | null; add: Add[]; beyond: { host: number; instance: number }[] };

const moving = (v: View, id: number) => v.moves.some(m => m.instanceId === id && !ended(m));
const failedLately = (v: View, id: number, reason: Move["reason"]) => v.moves.some(m => m.instanceId === id
	&& m.reason === reason && (m.step === "failed" || m.back) && v.now - (m.endedAt ?? 0) < RETRY_FAILED_MS);

/**
 * §4.3 unit 3, R1: the first rule with work takes the pass: failover (its moves found by the controller), drain,
 * overload, then the after-check's re-moves. A rule has work when it asks for moves now or one of its moves is
 * unfinished. P4: disabled, only drain runs, and `failover` comes empty.
 */
export function decide(v: View, failover: Add[], enabled: boolean): Decision {
	const holds = (rule: Move["reason"], add: Add[]) => add.length > 0
		|| v.moves.some(m => m.reason === rule && !ended(m));
	if (enabled && holds("failover", failover)) {
		return { rule: "failover", add: failover, beyond: [] };
	}
	const drain = drainMoves(v);
	if (holds("drain", drain)) {
		return { rule: "drain", add: drain, beyond: [] };
	}
	if (!enabled) {
		return { rule: null, add: [], beyond: [] };
	}
	const overload = overloadMoves(v);
	if (holds("overload", overload.add)) {
		return { rule: "overload", ...overload };
	}
	const recheck = recheckMoves(v);
	return { rule: holds("after_check", recheck) ? "after_check" : null, add: recheck, beyond: overload.beyond };
}

/**
 * §5.4, R12: per connected draining host with no drain move under way, its first tile that can go: running and empty
 * with a copy (the pre-flight needs one), or stopped. Occupied tiles wait; a tile whose drain move failed waits 10
 * minutes.
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
			&& ((x.status === "running" && x.players === 0 && x.hasCopy) || x.status === "stopped"));
		if (t) {
			add.push({ instanceId: t.id, from: h, reason: "drain", wasRunning: t.status === "running" });
		}
	}
	return add;
}

/**
 * §5.5, R16: per connected host that isn't benchmarking (R11) with a tile lagging (Telemetry.lagging), its heaviest
 * empty tile with a copy moves, at most once per host per 10 minutes. When the only lagging tile is the host's only
 * busy one, it moves only if it is empty and a benchmarked host predicts it under the 1000 / floor ms budget there
 * (the source benchmarked too); else it is beyond that host: named in `beyond`, not moved.
 */
export function overloadMoves(v: View): { add: Add[]; beyond: { host: number; instance: number }[] } {
	const add: Add[] = [];
	const beyond: { host: number; instance: number }[] = [];
	const ms = (id: number) => v.telemetry.meanMs(id) ?? -1;
	for (const h of v.connected) {
		if (v.benchmarking.has(h)) {
			continue;
		}
		const running = v.tiles.filter(t => t.host === h && t.status === "running");
		const lagging = running.filter(t => v.telemetry.lagging(t.id, v.floor, v.lagMs));
		if (lagging.length === 0) {
			continue;
		}
		const limited = v.moves.some(m => m.reason === "overload" && m.from === h
			&& (!ended(m) || v.now - m.startedAt < OVERLOAD_EVERY_MS));
		const busy = running.filter(t => ms(t.id) >= v.busyMs);
		if (busy.length === 1 && lagging.length === 1 && lagging[0] === busy[0]) {
			const t = busy[0];
			const from = v.speed(h);
			const faster = from !== null && v.connected.some(o => o !== h && !v.draining.includes(o)
				&& !v.benchmarking.has(o) && v.speed(o) !== null
				&& predictedMs(ms(t.id), from, v.speed(o)!) < 1000 / v.floor);
			if (t.players === 0 && t.hasCopy && !moving(v, t.id) && !limited && faster) {
				add.push({ instanceId: t.id, from: h, reason: "overload", wasRunning: true });
			} else {
				beyond.push({ host: h, instance: t.id });
			}
			continue;
		}
		if (limited) {
			continue;
		}
		const [heaviest] = running.filter(t => t.players === 0 && t.hasCopy && !moving(v, t.id))
			.sort((a, b) => ms(b.id) - ms(a.id));
		if (heaviest) {
			add.push({ instanceId: heaviest.id, from: h, reason: "overload", wasRunning: true });
		}
	}
	return { add, beyond };
}

/**
 * §5.6, R9, R15: the done moves due for their after-check: the move ran the tile, wasn't a failover (§5.3 runs steps 1
 * and 4–6) or a way back, and ended after_check_minutes ago. Judged on the last 5 minutes before it: T's mean UPS on
 * the target at the floor or above, and every sample of the target's other running tiles too. Not judged (ok null) when
 * T no longer runs there or has no sample.
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
			.flatMap(x => v.telemetry.minUps(x.id, from, v.now) ?? []);
		const othersMinUps = lows.length > 0 ? Math.min(...lows) : null;
		const ok = mine === undefined
			? null : mine.ups >= v.floor && (othersMinUps === null || othersMinUps >= v.floor);
		due.push({ move: m, check: { at: v.now, ups: mine?.ups ?? null, ms: mine?.ms ?? null, othersMinUps, ok } });
	}
	return due;
}

/**
 * §5.6, R10: record the after-check on its move. A failed one marks (T, H) bad, and lowers H's slots to the busy tiles
 * it carried when T's pre-flight passed there and H's other tiles slowed below `floor` (S3; never raising them).
 * Returns H's learned slots when it set them.
 */
export function applyCheck(
	m: Move, check: Check, s: Pick<State, "bad" | "hosts">, now: number, badPairMs: number, floor: number,
): number | undefined {
	m.check = check;
	if (check.ok !== false || m.to === null) {
		return undefined;
	}
	s.bad[`${m.instanceId}:${m.to}`] = now + badPairMs;
	if (!m.preflight || check.othersMinUps === null || check.othersMinUps >= floor) {
		return undefined;
	}
	s.hosts[m.to] ??= {};
	const h = s.hosts[m.to];
	h.learned = Math.min(m.preflight.busy, h.learned ?? h.bench?.slots ?? Infinity);
	return h.learned;
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
 * §5.7, R3: the hosts the join benchmark runs on automatically now: connected, their Factorio version reported, every
 * instance on them stopped (none running, none unknown), no move from or to them, not draining (M5), not skipped
 * (benchmarking, or failed this session), and no result yet or a stale one (another version or reference). A host with
 * a running tile is never benchmarked automatically: its players would lag for two minutes.
 */
export function benchmarksDue(
	v: View, versions: Map<number, string>, hosts: Record<string, HostState>, ref: string,
	skip: (hostId: number) => boolean,
): number[] {
	return v.connected.filter(h => {
		const version = versions.get(h);
		const bench = hosts[h]?.bench;
		return version !== undefined && !skip(h) && !v.draining.includes(h)
			&& v.tiles.every(t => t.host !== h || t.status === "stopped")
			&& !v.moves.some(m => !ended(m) && (m.from === h || m.to === h))
			&& (bench === undefined || bench.version !== version || bench.ref !== ref);
	});
}
