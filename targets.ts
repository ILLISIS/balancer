import type { Sample } from "./contracts.js";

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
): number[] {
	const tier1 = candidates(from, hosts, tiles, last, meanMs, floor, busyMs);
	const lowest = new Map<number, number>();
	for (const h of hosts) {
		if (!h.open || h.id === from || tier1.includes(h.id)) {
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
