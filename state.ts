import * as path from "node:path";
import { loadDataFile, saveDataFile, type Migration } from "universal_edges/runtime";
import type { Mark, Move, Reserve } from "./contracts.js";

/** A stored copy (§4.3 unit 1): the save it came from, its time on its host, and when it was pulled. */
export type Copy = { name: string; mtimeMs: number; size: number; pulledAt: number };
/**
 * Per host (capacity amendment C3): its cap, the running tiles it carries at most until `until` (ms), or none. A file
 * from before the amendment may hold `bench` and `learned` here, and `reference` beside `hosts`: nothing reads them.
 */
export type HostState = { cap?: { tiles: number; until: number } };

/**
 * balancer.json (§4.3): the copies, the moves (every unfinished one and the last 500 ended: the ledger), the bad pairs
 * ("<instance>:<host>" → until, ms), the instances that were running when their host went (§5.3), phase 2's hosts
 * and draining hosts (R2), each tile's memory figure (memory amendment §3.1), and the for-cause marks (capacity
 * amendment C8), and the reservation (C7).
 */
export type State = {
	copies: Record<string, Copy>;
	moves: Move[];
	bad: Record<string, number>;
	wasRunning: number[];
	hosts: Record<string, HostState>;
	draining: number[];
	/** Memory amendment §3.1: each tile's largest reported memory figure, bytes, by instance id. */
	memory: Record<string, number>;
	/** Capacity amendment C8: "<instance>:<host>" → why the tile isn't offered to that host again; no expiry. */
	marks: Record<string, Mark>;
	/** Capacity amendment C7: the one reservation; absent (as in a file from before it): none. */
	reserve?: Reserve;
};

/** Migrations of balancer.json. Append; never edit one. */
const MIGRATIONS: Migration[] = [
	// 1 → 2 (phase 2, R2): the hosts' benchmarks and learned slots, the draining hosts, the default reference; each
	// move's pre-flight result and after-check.
	data => ({
		...data,
		hosts: {},
		draining: [],
		reference: null,
		moves: data.moves.map((m: object) => ({ ...m, preflight: null, check: null })),
	}),
	// 2 → 3 (memory amendment §3.1): each tile's largest memory figure.
	data => ({ ...data, memory: {} }),
];
export const STATE_FILE = "balancer.json";

export function emptyState(): State {
	return { copies: {}, moves: [], bad: {}, wasRunning: [], hosts: {}, draining: [], memory: {}, marks: {} };
}

/**
 * The state in <dir>/balancer.json, and a save() that writes it. Writes run one after another, each with the state as
 * it is when its turn comes, so the file always ends as the latest state; a failed write doesn't stop the next.
 */
export async function openState(dir: string): Promise<{ state: State; save: () => Promise<void> }> {
	const file = path.join(dir, STATE_FILE);
	const state = (await loadDataFile(file, MIGRATIONS) as State | undefined) ?? emptyState();
	state.marks ??= {}; // capacity amendment C8: a file from before the marks has none; no schema bump
	let chain: Promise<void> = Promise.resolve();
	const save = () => {
		chain = chain.catch(() => undefined).then(() => saveDataFile(file, MIGRATIONS, state));
		return chain;
	};
	return { state, save };
}
