import type { Move, Reserve, Sample } from "./contracts.js";
import { ended } from "./mover.js";

/**
 * A host as §5.8 sees it: open for tiles (connected, not draining), its core count (null: not reported yet) and its
 * cap (capacity amendment C3; null: none): the running tiles it may carry.
 */
export type HostFact = { id: number; open: boolean; cores: number | null; cap: number | null };
export type TileFact = { id: number; host: number | null; status: string };

/**
 * The pre-flight's pass rule (C2, C3; capacity amendment C4): under `maxMs` per tick, and the target's running tiles at
 * `floor` UPS or above. No UPS sample in the window only passes a target with nothing running on it.
 */
export function verdict(
	msPerTick: number, minUps: number | null | undefined, maxMs: number, floor: number, targetHasRunning: boolean,
): boolean {
	return msPerTick < maxMs && (minUps === null || minUps === undefined ? !targetHasRunning : minUps >= floor);
}

const running = (tiles: TileFact[], hostId: number) => tiles.filter(t => t.host === hostId && t.status === "running");
const diff = (x: number, y: number) => (x === y ? 0 : x - y); // Infinity - Infinity is NaN

/**
 * Capacity amendment C2: a host's load, the all-thread CPU ms per tick (`meanMs`) of its running tiles and of the
 * tiles moving to it (`arriving`; each once, one with no figure counts 0), per core. Infinity, so after every measured
 * host, when a running tile has no figure or the host has reported no core count.
 */
function load(
	h: HostFact, tiles: TileFact[], meanMs: (instanceId: number) => number | undefined, arriving: number[],
): number {
	const on = running(tiles, h.id).map(t => t.id);
	if (h.cores === null || on.some(id => meanMs(id) === undefined)) {
		return Infinity;
	}
	return [...new Set([...on, ...arriving])].reduce((sum, id) => sum + (meanMs(id) ?? 0), 0) / h.cores;
}

/**
 * §5.8, capacity amendment C1–C3: the eligible targets, best first. Eligible: open, not `from`, every running tile on
 * it at `floor` UPS or above in its last sample (plan ruling 14; a tile with no sample yet doesn't block), fewer
 * running tiles than its cap, and `fits` (when given). Ranked by `load`, lowest first, then id. `arriving`: the tiles
 * of the unfinished moves to a host. The mover drops bad pairs; the pre-flight decides.
 */
export function candidates(
	from: number | null,
	hosts: HostFact[],
	tiles: TileFact[],
	last: (instanceId: number) => Sample | undefined,
	meanMs: (instanceId: number) => number | undefined,
	floor: number,
	fits?: (hostId: number) => boolean,
	arriving: (hostId: number) => number[] = () => [],
): number[] {
	const ranked: { id: number; load: number }[] = [];
	for (const h of hosts) {
		if (!h.open || h.id === from || fits?.(h.id) === false) {
			continue;
		}
		const on = running(tiles, h.id);
		if (on.some(t => (last(t.id)?.ups ?? floor) < floor) || (h.cap !== null && on.length >= h.cap)) {
			continue;
		}
		ranked.push({ id: h.id, load: load(h, tiles, meanMs, arriving(h.id)) });
	}
	return ranked.sort((a, b) => diff(a.load, b.load) || a.id - b.id).map(h => h.id);
}

/**
 * §5.3, best effort: `candidates` (tier 1, strict), then every other open host whose running tiles all sit at
 * `emergencyFloor` UPS or above in their last sample, whatever its cap (tier 2): the host whose lowest tile is fastest
 * first (none running counts as highest), then the lower `load`, then id.
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
	fits?: (hostId: number) => boolean,
	arriving: (hostId: number) => number[] = () => [],
): number[] {
	const tier1 = candidates(from, hosts, tiles, last, meanMs, floor, fits, arriving);
	const tier2: { id: number; lowest: number; load: number }[] = [];
	for (const h of hosts) {
		if (!h.open || h.id === from || tier1.includes(h.id) || fits?.(h.id) === false) {
			continue;
		}
		const ups = running(tiles, h.id).flatMap(t => last(t.id)?.ups ?? []);
		const lowest = ups.length > 0 ? Math.min(...ups) : Infinity;
		if (lowest >= emergencyFloor) {
			tier2.push({ id: h.id, lowest, load: load(h, tiles, meanMs, arriving(h.id)) });
		}
	}
	tier2.sort((a, b) => diff(b.lowest, a.lowest) || diff(a.load, b.load) || a.id - b.id);
	return [...tier1, ...tier2.map(h => h.id)];
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
	/** Capacity amendment C7: the reservation, if any; one past its `until` counts for nothing. */
	reserve?: Reserve;
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
 * and starting instances, those of unfinished moves to it (a pre-flight's copy or an arrival), and the tile room is
 * reserved for there until the reservation's `until` (capacity amendment C7), each once, never T. Fails closed: 0
 * without a reading 60 s old or newer. Negative over the limit. `leaving`: tiles taken off H first (C7 step 1); each
 * frees its recorded figure of `used` (none recorded: nothing; need()'s stand-in is a guess, not bytes that come back),
 * and its need from the sum.
 */
export function room(f: MemoryFacts, hostId: number, instanceId: number | null, leaving: number[] = []): number {
	const m = fresh(f, hostId);
	if (m === undefined) {
		return 0;
	}
	const on = new Set([
		...f.tiles.filter(t => t.host === hostId && (t.status === "running" || t.status === "starting")).map(t => t.id),
		...f.moves.filter(x => !ended(x) && x.to === hostId).map(x => x.instanceId),
		...(f.reserve?.host === hostId && f.reserve.until > f.now ? [f.reserve.instanceId] : []),
	]);
	if (instanceId !== null) {
		on.delete(instanceId);
	}
	leaving.forEach(id => on.delete(id));
	const needs = [...on].reduce((sum, id) => sum + need(f.figures, id), 0);
	const freed = leaving.reduce((sum, id) => sum + (f.figures[id] ?? 0), 0);
	return limitPct(f, hostId) / 100 * m.capacity - Math.max(m.capacity - m.available - freed, needs);
}

/**
 * §3.3: undefined when T (null: a new tile) fits on H, need(T) ≤ room(H); else why not, as the operator reads it
 * (M5, MR2). A host without a reading 60 s old or newer is named as such, not as having no room.
 */
export function noRoom(f: MemoryFacts, instanceId: number | null, hostId: number): string | undefined {
	if (fresh(f, hostId) === undefined) {
		return `host ${hostId} has sent no memory reading in 60 s`;
	}
	const n = need(f.figures, instanceId);
	const r = room(f, hostId, instanceId);
	return n <= r ? undefined : `host ${hostId} has room for ${mb(Math.max(0, r))} MB, it needs ${mb(n)} MB`;
}

/** Capacity amendment C5: T's test copy, which runs beside H's tiles, fits H's `available` bytes (a fresh reading). */
export function withinAvailable(f: MemoryFacts, instanceId: number, hostId: number): boolean {
	const m = fresh(f, hostId);
	return m !== undefined && need(f.figures, instanceId) <= m.available;
}

/**
 * Capacity amendment C5, C7 step 1: T, short of memory on H, may still be pre-flighted there and have room made: its
 * need is within H's `available` bytes by a fresh reading (the test's copy runs beside H's tiles), and within the room
 * H has once `evictable`, its empty tiles that have a target, have all left: `room` with `leaving`, so where `used`
 * binds they free their figures, not their needs.
 */
export function roomable(f: MemoryFacts, instanceId: number, hostId: number, evictable: number[]): boolean {
	const n = need(f.figures, instanceId);
	return withinAvailable(f, instanceId, hostId) && n <= room(f, hostId, instanceId, evictable);
}

/** §3.6 (M1): gridworld may place a new tile on H: H isn't draining (balancer §5.4), and a new tile fits there. */
export function accepts(f: MemoryFacts, draining: number[], hostId: number): boolean {
	return !draining.includes(hostId) && noRoom(f, null, hostId) === undefined;
}

/**
 * Capacity amendment C8: the hosts of `ranked` a tile is offered, in their order: never one it is `marked` on (it left
 * that host for cause), nor a `bad` pair. A failover or a drain (`lastResort`) takes the marked ones once no unmarked
 * host is left: a tile with no host is worse than a tile on a poor one, and a drain is the owner's own request.
 */
export function offered(
	ranked: number[], marked: (hostId: number) => boolean, bad: (hostId: number) => boolean, lastResort: boolean,
): number[] {
	const open = ranked.filter(h => !bad(h));
	const unmarked = open.filter(h => !marked(h));
	return unmarked.length > 0 || !lastResort ? unmarked : open;
}
