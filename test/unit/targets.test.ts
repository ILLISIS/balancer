import { test } from "node:test";
import assert from "node:assert/strict";
import { candidates, verdict, type HostFact } from "../../targets.js";

const host = (id: number, extra: Partial<HostFact> = {}): HostFact => (
	{ id, open: true, speed: null, slots: null, ...extra }
);

test("§5.8: open hosts but the source, not lagging, under their slots; fastest first, unbenchmarked last", () => {
	const hosts = [
		host(1, { speed: 0.4 }), // the source
		host(2, { speed: 0.9 }),
		host(3, { speed: 0.5 }),
		host(4, { speed: 0.3, open: false }), // disconnected, draining or benchmarking
		host(5, { speed: 0.2 }), // a tile under the floor
		host(6, { speed: 0.1, slots: 1 }), // full: 1 busy tile in 1 slot
		host(7), // unbenchmarked, no busy tile
		host(8), // unbenchmarked, 1 busy tile
	];
	const tiles = [
		{ id: 50, host: 5, status: "running" }, { id: 60, host: 6, status: "running" },
		{ id: 80, host: 8, status: "running" },
	];
	const ups: Record<number, number> = { 50: 57, 60: 60, 80: 60 };
	const ms: Record<number, number> = { 60: 3, 80: 3 };
	const last = (id: number) => (ups[id] === undefined ? undefined : { at: 1, ups: ups[id], ms: null });
	assert.deepEqual(candidates(1, hosts, tiles, last, id => ms[id], 58, 2), [3, 2, 7, 8]);
});

test("a stopped tile's low UPS doesn't block its host", () => {
	const hosts = [host(1), host(2)];
	const tiles = [{ id: 20, host: 2, status: "stopped" }];
	const last = () => ({ at: 1, ups: 10, ms: null });
	assert.deepEqual(candidates(1, hosts, tiles, last, () => undefined, 58, 2), [2]);
});

test("slots count busy tiles only (§5.8)", () => {
	const hosts = [host(1, { speed: 0.5, slots: 2 })];
	const tiles = [{ id: 10, host: 1, status: "running" }, { id: 11, host: 1, status: "running" }];
	const ms: Record<number, number> = { 10: 3, 11: 0.5 };
	assert.deepEqual(candidates(null, hosts, tiles, () => undefined, id => ms[id], 58, 2), [1], "1 busy of 2 slots");
	ms[11] = 2;
	assert.deepEqual(candidates(null, hosts, tiles, () => undefined, id => ms[id], 58, 2), [], "2 busy of 2 slots");
});

test("C11: a host with an empty tile list ranks before one that reports no CPU readings", () => {
	const hosts = [host(1), host(2)];
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
