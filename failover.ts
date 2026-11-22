import type { Move } from "./contracts.js";

/** A failed failover of an instance is tried again after this long (plan ruling 18). */
export const RETRY_FAILED_MS = 600_000;

/**
 * C44: Clusterio's assign leaves an instance unassigned when it throws, so a failover that failed there has no host.
 * Such a tile counts as still on that failover's source, which keeps the retry seeing it.
 */
export function adoptOrphans<T extends { id: number; host: number | null }>(tiles: T[], moves: Move[]): T[] {
	return tiles.map(t => {
		const latest = t.host === null ? moves.filter(m => m.instanceId === t.id).at(-1) : undefined;
		return latest?.reason === "failover" && latest.step === "failed" && latest.from !== null
			? { ...t, host: latest.from } : t;
	});
}

/**
 * A move that failed after its assign, with no way back, leaves the tile stopped on its target without its save
 * there (§5.2 steps 5-6), where no gone host or unassigned tile would bring failover to it. Such a tile (its host is
 * the latest move's target, which did not go back) is tried again by a failover pinned to that host, once the move
 * ended `retryMs` ago (plan ruling 18).
 */
export function stranded(
	tiles: { id: number; host: number | null; status: string }[],
	moves: Move[],
	now: number,
	retryMs: number,
	skip: (instanceId: number) => boolean,
	hasCopy: (instanceId: number) => boolean,
): { instanceId: number; from: number; to: number }[] {
	const found: { instanceId: number; from: number; to: number }[] = [];
	for (const t of tiles) {
		const latest = t.host === null ? undefined : moves.filter(m => m.instanceId === t.id).at(-1);
		if (
			latest?.step === "failed" && !latest.back && latest.to === t.host && t.status === "stopped"
			&& now - (latest.endedAt ?? 0) >= retryMs && !skip(t.id) && hasCopy(t.id)
		) {
			found.push({ instanceId: t.id, from: t.host!, to: t.host! });
		}
	}
	return found;
}

/**
 * §5.3: the hosts away for the grace or longer (`gone` and `now` share one monotonic clock, C51). Only hosts whose
 * session the controller has closed: reassigning an
 * instance while its old host's session is still open fails with "Session Closed" (spike 32).
 */
export function goneHosts(
	gone: Map<number, number>, now: number, graceMs: number, connected: (hostId: number) => boolean,
): number[] {
	return [...gone].filter(([id, since]) => now - since >= graceMs && !connected(id)).map(([id]) => id);
}

/**
 * §5.3's moves for one pass: every instance assigned to a gone host, unless `skip` (moving now, or a failover that
 * failed lately). One without a stored copy is not moved, since the target would start a new map (plan ruling 6).
 */
export function failovers(
	goneIds: number[],
	tiles: { id: number; host: number | null }[],
	skip: (instanceId: number) => boolean,
	hasCopy: (instanceId: number) => boolean,
): { move: { instanceId: number; from: number }[]; noCopy: number[] } {
	const move: { instanceId: number; from: number }[] = [];
	const noCopy: number[] = [];
	for (const t of tiles) {
		if (t.host === null || !goneIds.includes(t.host) || skip(t.id)) {
			continue;
		}
		if (hasCopy(t.id)) {
			move.push({ instanceId: t.id, from: t.host });
		} else {
			noCopy.push(t.id);
		}
	}
	return { move, noCopy };
}

/**
 * Whether failover starts the instance on the target: it was running when its host went (`recorded`), or its latest
 * move failed with it stopped (C26). A failed non-failover move counts once it got past the pre-flight: a failed
 * record's step is "failed", so that reads as `save`, which the stop step sets before the tick read and the players
 * check (C35). A failed failover counts always: it carries the wasRunning it got by this same rule (a failover sets
 * `save` only at push, so a pre-flight or assign failure has none).
 */
export function wasRunningBefore(instanceId: number, recorded: number[], moves: Move[]): boolean {
	if (recorded.includes(instanceId)) {
		return true;
	}
	const latest = moves.filter(m => m.instanceId === instanceId).at(-1);
	return latest?.step === "failed" && latest.wasRunning
		&& (latest.save !== null || latest.reason === "failover");
}

/** C34: forget the recorded instances `ids` (a host that came back before failover: the operator decides then). */
export function forget(recorded: number[], ids: number[]): void {
	for (const id of ids) {
		const i = recorded.indexOf(id);
		if (i !== -1) {
			recorded.splice(i, 1);
		}
	}
}
