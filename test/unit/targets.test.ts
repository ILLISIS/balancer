import { test } from "node:test";
import assert from "node:assert/strict";
import { candidates, verdict } from "../../targets.js";

test("§5.8 in phase 1: connected hosts but the source, not lagging, fewest busy tiles first, then by id", () => {
	const hosts = [1, 2, 3, 4, 5, 6].map(id => ({ id, connected: id !== 4 }));
	const tiles = [
		{ id: 10, host: 2, status: "running" }, { id: 11, host: 2, status: "running" },
		{ id: 20, host: 3, status: "running" }, { id: 21, host: 3, status: "stopped" },
		{ id: 50, host: 5, status: "running" },
		{ id: 60, host: 6, status: "running" }, // no sample yet: it doesn't block its host, but it can't be compared
	];
	const ups: Record<number, number> = { 10: 60, 11: 59, 20: 60, 21: 10, 50: 57 };
	const ms: Record<number, number> = { 10: 3, 11: 2.5, 20: 2, 21: 9 };
	const last = (id: number) => (ups[id] === undefined ? undefined : { at: 1, ups: ups[id], ms: null });
	// 1 is the source, 4 is disconnected, 5 has a tile under the floor;
	// 3 has 1 busy (21 is stopped), 2 has 2, 6 has no CPU reading so it ranks last (C11).
	assert.deepEqual(candidates(1, hosts, tiles, last, id => ms[id], 58, 2), [3, 2, 6]);
	assert.deepEqual(candidates(null, hosts, [], last, () => undefined, 58, 2), [1, 2, 3, 5, 6]);
});

test("C11: a host with an empty tile list ranks before one that reports no CPU readings", () => {
	const hosts = [{ id: 1, connected: true }, { id: 2, connected: true }];
	const tiles = [{ id: 10, host: 1, status: "running" }];
	assert.deepEqual(candidates(null, hosts, tiles, () => undefined, () => undefined, 58, 2), [2, 1]);
});

test("C2/C3: the pre-flight verdict", () => {
	assert.equal(verdict(5, 60, 10, 58, true), true);
	assert.equal(verdict(12, 60, 10, 58, true), false);
	assert.equal(verdict(5, 40, 10, 58, true), false);
	assert.equal(verdict(5, null, 10, 58, false), true);
	assert.equal(verdict(5, null, 10, 58, true), false);
});
