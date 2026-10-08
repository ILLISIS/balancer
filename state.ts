import * as path from "node:path";
import { loadDataFile, saveDataFile, type Migration } from "universal_edges/runtime";
import type { Move } from "./contracts.js";

/** A stored copy (§4.3 unit 1): the save it came from, its time on its host, and when it was pulled. */
export type Copy = { name: string; mtimeMs: number; size: number; pulledAt: number };

/**
 * balancer.json (§4.3): the copies, the moves (every unfinished one and the last 50 ended), the bad pairs
 * ("<instance>:<host>" → until, ms) and the instances that were running when their host went (§5.3).
 */
export type State = { copies: Record<string, Copy>; moves: Move[]; bad: Record<string, number>; wasRunning: number[] };

/** Migrations of balancer.json. Append; never edit one. */
const MIGRATIONS: Migration[] = [];
export const STATE_FILE = "balancer.json";

export function emptyState(): State {
	return { copies: {}, moves: [], bad: {}, wasRunning: [] };
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
