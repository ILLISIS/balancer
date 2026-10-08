import * as path from "node:path";
import { loadDataFile, saveDataFile, type Migration } from "universal_edges/runtime";
import type { Move } from "./contracts.js";

/** A stored copy (§4.3 unit 1): the save it came from, its time on its host, and when it was pulled. */
export type Copy = { name: string; mtimeMs: number; size: number; pulledAt: number };
/**
 * A host's join benchmark (§5.7): one copy's ms per tick, the slots, the Factorio version the host reported (R8), the
 * reference it ran (R7), and when.
 */
export type Bench = { speed: number; slots: number; version: string; ref: string; at: number };
/** Per host: its benchmark and its learned slots (§5.6), either absent. */
export type HostState = { bench?: Bench; learned?: number };
/** The default reference save (P5, R7): a busy tile's copy, frozen with its mod pack and Factorio version. */
export type Reference = { instanceId: number; modPackId: number | null; version: string };

/**
 * balancer.json (§4.3): the copies, the moves (every unfinished one and the last 500 ended: the ledger), the bad pairs
 * ("<instance>:<host>" → until, ms), the instances that were running when their host went (§5.3), and phase 2's hosts,
 * draining hosts and default reference (R2).
 */
export type State = {
	copies: Record<string, Copy>;
	moves: Move[];
	bad: Record<string, number>;
	wasRunning: number[];
	hosts: Record<string, HostState>;
	draining: number[];
	reference: Reference | null;
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
];
export const STATE_FILE = "balancer.json";

export function emptyState(): State {
	return { copies: {}, moves: [], bad: {}, wasRunning: [], hosts: {}, draining: [], reference: null };
}

/**
 * The state in <dir>/balancer.json, and a save() that writes it. Writes run one after another, each with the state as
 * it is when its turn comes, so the file always ends as the latest state; a failed write doesn't stop the next.
 */
export async function openState(dir: string): Promise<{ state: State; save: () => Promise<void> }> {
	const file = path.join(dir, STATE_FILE);
	const state = (await loadDataFile(file, MIGRATIONS) as State | undefined) ?? emptyState();
	let chain: Promise<void> = Promise.resolve();
	const save = () => {
		chain = chain.catch(() => undefined).then(() => saveDataFile(file, MIGRATIONS, state));
		return chain;
	};
	return { state, save };
}
