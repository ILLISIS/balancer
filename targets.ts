import type { Move, Sample } from "./contracts.js";
import { ended } from "./mover.js";

/** A host as §5.8 sees it: open for tiles (connected, not draining, not benchmarking: R11), its speed and slots. */
export type HostFact = { id: number; open: boolean; speed: number | null; slots: number | null };
export type TileFact = { id: number; host: number | null; status: string };

/**
 * The pre-flight's pass rule (C2, C3): under `maxMs` per tick, and the target's running tiles at `floor` UPS or above.
 * No UPS sample in the window only passes a target with nothing running on it.
 */
export function verdict(
	msPerTick: number, minUps: number | null | undefined, maxMs: number, floor: number, targetHasRunning: boolean,
): boolean {
	return msPerTick < maxMs && (minUps === null || minUps === undefined ? !targetHasRunning : minUps >= floor);
}

/** A tile's ms per tick measured on a host of speed `fromSpeed`, predicted on one of speed `toSpeed`. */
export function predictedMs(ms: number, fromSpeed: number, toSpeed: number): number {
	return ms * toSpeed / fromSpeed;
}

/**
 * §5.8: the eligible targets, best first. Eligible: open, not `from`, every running tile on it at `floor` UPS or above
 * in its last sample (plan ruling 14; a tile with no sample yet doesn't block), fewer busy tiles (the last minute's
 * mean CPU ms per tick at `busyMs` or more) than its slots (null: no limit), and `fits` (when given). Ranked by
 * headroom: the benchmarked first, by most free slots (no limit counts as most), then fastest, then id; then the
 * unbenchmarked, by the fewest busy tiles, those with no CPU reading after them (C11), then by id. The mover drops
 * bad pairs; the pre-flight decides.
 */
export function candidates(
	from: number | null,
	hosts: HostFact[],
	tiles: TileFact[],
	last: (instanceId: number) => Sample | undefined,
	meanMs: (instanceId: number) => number | undefined,
	floor: number,
	busyMs: number,
	fits?: (hostId: number) => boolean,
): number[] {
	const ranked: { id: number; speed: number | null; free: number; blind: boolean; busy: number }[] = [];
	for (const h of hosts) {
		if (!h.open || h.id === from || fits?.(h.id) === false) {
			continue;
		}
		const running = tiles.filter(t => t.host === h.id && t.status === "running");
		if (running.some(t => (last(t.id)?.ups ?? floor) < floor)) {
			continue;
		}
		const busy = running.filter(t => (meanMs(t.id) ?? 0) >= busyMs).length;
		if (h.slots !== null && busy >= h.slots) {
			continue;
		}
		// C11: a host with running tiles and no CPU reading (no /proc) can't be compared: it ranks after measured ones.
		const blind = running.length > 0 && running.every(t => meanMs(t.id) === undefined);
		ranked.push({ id: h.id, speed: h.speed, free: h.slots === null ? Infinity : h.slots - busy, blind, busy });
	}
	const cmp = (a: typeof ranked[number], b: typeof ranked[number]) => {
		if ((a.speed === null) !== (b.speed === null)) {
			return a.speed === null ? 1 : -1;
		}
		if (a.speed === null || b.speed === null) {
			return Number(a.blind) - Number(b.blind) || a.busy - b.busy || a.id - b.id;
		}
		// Infinity - Infinity is NaN: equal free slots fall through to the speed.
		return (a.free === b.free ? 0 : b.free - a.free) || a.speed - b.speed || a.id - b.id;
	};
	return ranked.sort(cmp).map(h => h.id);
}

/**
 * §5.3, best effort: `candidates` (tier 1, strict), then every other open host whose running tiles all sit at
 * `emergencyFloor` UPS or above in their last sample, whatever its slots (tier 2): the host whose lowest tile is
 * fastest first (none running counts as highest), then the faster host, the unbenchmarked last, then id.
 * Memory amendment §3.4 (M4): `fits`, when given, gates both tiers; best effort never overrides it.
 */
export function failoverCandidates(
	from: number | null,
	hosts: HostFact[],
	tiles: TileFact[],
	last: (instanceId: number) => Sample | undefined,
	meanMs: (instanceId: number) => number | undefined,
	floor: number,
	emergencyFloor: number,
	busyMs: number,
	fits?: (hostId: number) => boolean,
): number[] {
	const tier1 = candidates(from, hosts, tiles, last, meanMs, floor, busyMs, fits);
	const lowest = new Map<number, number>();
	for (const h of hosts) {
		if (!h.open || h.id === from || tier1.includes(h.id) || fits?.(h.id) === false) {
			continue;
		}
		const ups = tiles.filter(t => t.host === h.id && t.status === "running")
			.flatMap(t => last(t.id)?.ups ?? []);
		const min = ups.length > 0 ? Math.min(...ups) : Infinity;
		if (min >= emergencyFloor) {
			lowest.set(h.id, min);
		}
	}
	const speed = (id: number) => hosts.find(h => h.id === id)?.speed ?? Infinity;
	const diff = (x: number, y: number) => (x === y ? 0 : x - y); // Infinity - Infinity is NaN
	const tier2 = [...lowest.keys()].sort(
		(a, b) => diff(lowest.get(b)!, lowest.get(a)!) || diff(speed(a), speed(b)) || a - b,
	);
	return [...tier1, ...tier2];
}

/** Memory amendment §3.1: a tile's need is its memory figure times this. */
export const MARGIN = 1.2;
/** §3.1: the figure taken when no tile has reported one: 1 GiB (the dev tiles peak at 0.72 GB). */
export const NO_FIGURE = 2 ** 30;
/** §3.2: a host's reading older than this gives it no room. */
export const STALE_MS = 60_000;
/** §3.2 (M3): a host's balancer.memory_limit_pct until it reports its own. */
export const LIMIT_PCT = 90;

/** A host's machine memory as its HostMemoryEvent reported it (MR-C1): bytes, and when the controller received it. */
export type HostMemory = { capacity: number; available: number; at: number };
/**
 * What the memory rule reads (§3.1–§3.3, MR1); the controller builds it from balancer.json and the hosts'
 * HostMemoryEvents.
 */
export type MemoryFacts = {
	now: number;
	/** Each tile's largest reported figure, bytes (balancer.json's `memory`). */
	figures: Record<string, number>;
	/** A host's reading; undefined: none. */
	memory: (hostId: number) => HostMemory | undefined;
	/** The limits the hosts reported (HostMemoryEvent). */
	limits: Map<number, number>;
	tiles: TileFact[];
	moves: Move[];
};

export const mb = (bytes: number) => Math.round(bytes / 2 ** 20);

/** §3.2: a host's balancer.memory_limit_pct, 90 until it has reported one. */
export function limitPct(f: MemoryFacts, hostId: number): number {
	return f.limits.get(hostId) ?? LIMIT_PCT;
}

/**
 * §3.1: T's figure × 1.2; with no figure (or T null: a new tile), the cluster's largest figure × 1.2; with none at
 * all, 1 GiB × 1.2.
 */
export function need(figures: Record<string, number>, instanceId: number | null): number {
	const all = Object.values(figures);
	const own = instanceId === null ? undefined : figures[instanceId];
	return (own ?? (all.length > 0 ? Math.max(...all) : NO_FIGURE)) * MARGIN;
}

/** §3.2: H's reading, if it is 60 s old or newer. */
function fresh(f: MemoryFacts, hostId: number): HostMemory | undefined {
	const m = f.memory(hostId);
	return m !== undefined && f.now - m.at <= STALE_MS ? m : undefined;
}

/**
 * §3.2: the percent of H's memory in use (the web UI's figure), by a reading 60 s old or newer; null without one.
 * MR9: used × 100 / capacity, so a reading exactly at a whole-percent limit reads as exactly that.
 */
export function usedPct(f: MemoryFacts, hostId: number): number | null {
	const m = fresh(f, hostId);
	return m === undefined ? null : (m.capacity - m.available) * 100 / m.capacity;
}

/** §3.5: H uses more than its limit, by a fresh reading. At the limit, or with a stale or missing reading: not over. */
export function overLimit(f: MemoryFacts, hostId: number): boolean {
	const used = usedPct(f, hostId);
	return used !== null && used > limitPct(f, hostId);
}

/**
 * §3.2: room(H) for T (null: a new tile) = limit% × capacity − max(used, Σ need of H's tiles). H's tiles: its running
 * and starting instances, and those of unfinished moves to it (a pre-flight's copy or an arrival), each once, never
 * T. Fails closed: 0 without a reading 60 s old or newer. Negative over the limit.
 */
export function room(f: MemoryFacts, hostId: number, instanceId: number | null): number {
	const m = fresh(f, hostId);
	if (m === undefined) {
		return 0;
	}
	const on = new Set([
		...f.tiles.filter(t => t.host === hostId && (t.status === "running" || t.status === "starting")).map(t => t.id),
		...f.moves.filter(x => !ended(x) && x.to === hostId).map(x => x.instanceId),
	]);
	if (instanceId !== null) {
		on.delete(instanceId);
	}
	const needs = [...on].reduce((sum, id) => sum + need(f.figures, id), 0);
	return limitPct(f, hostId) / 100 * m.capacity - Math.max(m.capacity - m.available, needs);
}

/**
 * §3.3: undefined when T (null: a new tile) fits on H, need(T) ≤ room(H); else why not, as the operator reads it
 * (M5, MR2).
 */
export function noRoom(f: MemoryFacts, instanceId: number | null, hostId: number): string | undefined {
	const n = need(f.figures, instanceId);
	const r = room(f, hostId, instanceId);
	return n <= r ? undefined : `host ${hostId} has room for ${mb(Math.max(0, r))} MB, it needs ${mb(n)} MB`;
}

/** §3.6 (M1): gridworld may place a new tile on H: H isn't draining (balancer §5.4), and a new tile fits there. */
export function accepts(f: MemoryFacts, draining: number[], hostId: number): boolean {
	return !draining.includes(hostId) && noRoom(f, null, hostId) === undefined;
}
