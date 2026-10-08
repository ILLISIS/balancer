import type { Sample } from "./contracts.js";

export type HostFact = { id: number; connected: boolean };
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
 * §5.8 in phase 1 (§11: no benchmark yet, so no speed or slots). Eligible: connected, not `from`, and every running
 * tile on it at `floor` UPS or above in its last sample (plan ruling 14; a tile with no sample yet doesn't
 * block). Ranked by the fewest busy tiles (the last minute's mean CPU ms per tick at `busyMs` or more), then by id.
 * The pre-flight decides.
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
	const ranked: { id: number; blind: boolean; busy: number }[] = [];
	for (const h of hosts) {
		if (!h.connected || h.id === from) {
			continue;
		}
		const running = tiles.filter(t => t.host === h.id && t.status === "running");
		if (running.some(t => (last(t.id)?.ups ?? floor) < floor)) {
			continue;
		}
		// C11: a host with running tiles and no CPU reading (no /proc) can't be compared: it ranks after measured ones.
		const blind = running.length > 0 && running.every(t => meanMs(t.id) === undefined);
		ranked.push({ id: h.id, blind, busy: running.filter(t => (meanMs(t.id) ?? 0) >= busyMs).length });
	}
	return ranked.sort((a, b) => Number(a.blind) - Number(b.blind) || a.busy - b.busy || a.id - b.id).map(h => h.id);
}
