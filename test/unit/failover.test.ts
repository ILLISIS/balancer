import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptOrphans, failovers, forget, goneHosts, stranded, wasRunningBefore } from "../../failover.js";
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
	type Spec = { instanceId: number; step: Move["step"]; wasRunning: boolean; save: string | null; reason: string };
	const move = (
		instanceId: number, step: Move["step"], wasRunning: boolean, save: string | null = "s.zip",
		reason = "manual",
	) => ({ instanceId, step, wasRunning, save, reason } as Spec as Move);
	const moves = [
		move(1, "failed", true), move(2, "failed", false), move(3, "failed", true), move(3, "done", true),
		move(7, "failed", true, null, "failover"), // a failover that failed before its push
		move(6, "failed", true, null), // failed in the pre-flight (C35): nothing was stopped
	];
	assert.equal(wasRunningBefore(1, [], moves), true);
	assert.equal(wasRunningBefore(2, [], moves), false);
	assert.equal(wasRunningBefore(3, [], moves), false); // its latest move is done
	assert.equal(wasRunningBefore(4, [4], moves), true);
	assert.equal(wasRunningBefore(5, [], moves), false);
	assert.equal(wasRunningBefore(6, [], moves), false);
	assert.equal(wasRunningBefore(7, [], moves), true);
	assert.equal(wasRunningBefore(6, [6], moves), true);
});

test("forget drops the recorded instances of a host that came back (C34)", () => {
	const recorded = [1, 2, 3];
	forget(recorded, [2, 9]);
	assert.deepEqual(recorded, [1, 3]);
});

test("an unassigned tile whose latest move is a failed failover counts as on that move's source (C44)", () => {
	const mv = (instanceId: number, reason: string, step: string, from: number | null) => (
		{ instanceId, reason, step, from } as unknown as Move
	);
	const tiles = [{ id: 10, host: null }, { id: 11, host: null }, { id: 12, host: null }, { id: 13, host: 3 }];
	const moves = [
		mv(10, "failover", "failed", 2), mv(11, "manual", "failed", 2), mv(12, "failover", "failed", 2),
		mv(12, "failover", "done", 2),
	];
	const adopted = adoptOrphans(tiles, moves);
	assert.deepEqual(adopted.map(t => t.host), [2, null, null, 3]);
	assert.deepEqual(failovers([2], adopted, () => false, () => true).move, [{ instanceId: 10, from: 2 }]);
});

test("a tile left stopped on the target of a move that failed after its assign is tried there again (issue 4)", () => {
	const mv = (instanceId: number, step: string, to: number | null, back = false, endedAt = 0) => (
		{ instanceId, reason: "failover", step, to, back, endedAt } as unknown as Move
	);
	const tile = (id: number, host: number | null, status = "stopped") => ({ id, host, status });
	const tiles = [
		tile(10, 2), tile(11, 2), tile(12, 1), tile(13, 2), tile(14, 2, "running"), tile(15, 2), tile(16, 2),
		tile(17, null),
	];
	const moves = [
		mv(10, "failed", 2), // stranded: assigned to 2, push failed, no way back
		mv(11, "failed", 2, false, 500_000), // failed 100 s ago: not yet
		mv(12, "failed", 2), // the tile is not on the target: it never got there
		mv(13, "failed", 2, true), // went back, so it is not on the move's first target
		mv(14, "failed", 2), // running: nothing to redo
		mv(15, "failed", 2), mv(15, "done", 2), // a later move finished
		mv(16, "failed", 2), // has no stored copy
		mv(17, "failed", null),
	];
	const found = stranded(tiles, moves, 600_000, 600_000, id => id === 99, id => id !== 16);
	assert.deepEqual(found, [{ instanceId: 10, from: 2, to: 2 }]);
	const rest = stranded(tiles, moves, 600_000, 600_000, id => id === 10, () => true); // 10 is moving now
	assert.deepEqual(rest.map(f => f.instanceId), [16]);
});
