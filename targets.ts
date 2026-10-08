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

/**
 * §5.8: the eligible targets, best first. Eligible: open, not `from`, every running tile on it at `floor` UPS or above
 * in its last sample (plan ruling 14; a tile with no sample yet doesn't block), and fewer busy tiles (the last minute's
 * mean CPU ms per tick at `busyMs` or more) than its slots (null: no limit). Ranked by speed, fastest first; the
 * unbenchmarked last, by the fewest busy tiles, those with no CPU reading after them (C11), then by id. The mover drops
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
): number[] {
	const ranked: { id: number; speed: number; blind: boolean; busy: number }[] = [];
	for (const h of hosts) {
		if (!h.open || h.id === from) {
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
		ranked.push({ id: h.id, speed: h.speed ?? Infinity, blind, busy });
	}
	// Two unbenchmarked hosts compare Infinity with Infinity, which is NaN: the next key decides.
	ranked.sort((a, b) => a.speed - b.speed || Number(a.blind) - Number(b.blind) || a.busy - b.busy || a.id - b.id);
	return ranked.map(h => h.id);
}
