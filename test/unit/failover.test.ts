import { test } from "node:test";
import assert from "node:assert/strict";
import { failovers, goneHosts, wasRunningBefore } from "../../failover.js";
import type { Move } from "../../contracts.js";

test("a host is gone once it has been away for the grace and its session is closed (§5.3, spike 32)", () => {
	const gone = new Map([[1, 0], [2, 500_000], [3, 0]]);
	const connected = (id: number) => id === 3; // 3 dropped long ago but resumed its session
	assert.deepEqual(goneHosts(gone, 900_000, 900_000, connected), [1]);
	assert.deepEqual(goneHosts(gone, 1_400_000, 900_000, connected), [1, 2]);
});

test("failovers: each instance of a gone host with a copy and no move under way; no-copy ones are named", () => {
	const tiles = [
		{ id: 10, host: 1 }, { id: 11, host: 1 }, { id: 12, host: 1 }, { id: 13, host: 1 }, { id: 20, host: 2 },
	];
	const r = failovers([1], tiles, id => id === 11, id => id !== 12);
	assert.deepEqual(r, { move: [{ instanceId: 10, from: 1 }, { instanceId: 13, from: 1 }], noCopy: [12] });
	assert.deepEqual(failovers([], tiles, () => false, () => true), { move: [], noCopy: [] });
});

test("was running: recorded when the host went, or the latest move failed after it had been running (C26)", () => {
	type Spec = { instanceId: number; step: Move["step"]; wasRunning: boolean };
	const move = (instanceId: number, step: Move["step"], wasRunning: boolean) => (
		{ instanceId, step, wasRunning } as Spec as Move
	);
	const moves = [move(1, "failed", true), move(2, "failed", false), move(3, "failed", true), move(3, "done", true)];
	assert.equal(wasRunningBefore(1, [], moves), true);
	assert.equal(wasRunningBefore(2, [], moves), false);
	assert.equal(wasRunningBefore(3, [], moves), false); // its latest move is done
	assert.equal(wasRunningBefore(4, [4], moves), true);
	assert.equal(wasRunningBefore(5, [], moves), false);
});
