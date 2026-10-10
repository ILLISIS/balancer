import { test } from "node:test";
import assert from "node:assert/strict";
import type { Move } from "../../contracts.js";
import {
	accepts, candidates, failoverCandidates, need, noRoom, overLimit, predictedMs, room, usedPct, verdict,
	type HostFact, type HostMemory, type MemoryFacts,
} from "../../targets.js";

const host = (id: number, extra: Partial<HostFact> = {}): HostFact => (
	{ id, open: true, speed: null, slots: null, ...extra }
);

test("§5.8: open hosts but the source, not lagging, under their slots; by free slots, then speed", () => {
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

test("ranking by headroom: more free slots first, equal free slots fastest first", () => {
	const hosts = [
		host(1, { speed: 0.3, slots: 2 }), host(2, { speed: 0.9, slots: 4 }), host(3, { speed: 0.5, slots: 4 }),
		host(4, { speed: 0.1 }),
	];
	assert.deepEqual(candidates(null, hosts, [], () => undefined, () => undefined, 58, 2), [4, 3, 2, 1]);
});

test("fits drops a host", () => {
	const hosts = [host(1, { speed: 0.3 }), host(2, { speed: 0.5 })];
	assert.deepEqual(candidates(null, hosts, [], () => undefined, () => undefined, 58, 2, h => h !== 1), [2]);
});

test("predictedMs scales by the speed ratio", () => {
	assert.equal(predictedMs(10, 1, 0.5), 5);
});

test("failover: hosts with room first, then full ones; under the emergency floor and `from` excluded", () => {
	const hosts = [
		host(1, { speed: 0.5 }), host(2, { speed: 0.9, slots: 1 }), host(3, { speed: 0.4, slots: 1 }),
		host(4, { speed: 0.2, slots: 1 }), host(5, { speed: 0.6, slots: 3 }),
	];
	const tiles = [
		{ id: 20, host: 2, status: "running" }, { id: 30, host: 3, status: "running" },
		{ id: 40, host: 4, status: "running" },
	];
	const ups: Record<number, number> = { 20: 50, 30: 55, 40: 40 };
	const last = (id: number) => ({ at: 1, ups: ups[id], ms: null });
	const ms = () => 3;
	assert.deepEqual(failoverCandidates(1, hosts, tiles, last, ms, 58, 45, 2), [5, 3, 2], "4 has a tile under 45");
	assert.deepEqual(failoverCandidates(1, hosts.filter(h => h.id !== 5), tiles, last, ms, 58, 45, 2), [3, 2]);
});

const GIB = 2 ** 30;
const NOW = 1_000_000;
/** A reading of a 10 GiB host with `used` GiB in use, taken `age` ms before NOW. */
const reading = (used: number, age = 10_000): HostMemory => (
	{ capacity: 10 * GIB, available: (10 - used) * GIB, at: NOW - age }
);
/** Memory facts at NOW: every host reads 4 GiB used of 10, no limit reported (so 90 %), no figures, tiles or moves. */
const facts = (over: Partial<MemoryFacts> = {}): MemoryFacts => ({
	now: NOW, figures: {}, memory: () => reading(4), limits: new Map(), tiles: [], moves: [], ...over,
});
/** An unfinished move of `instanceId` from host 3 to host `to`. */
const arriving = (instanceId: number, to: number, step: Move["step"] = "push"): Move => ({
	id: `${instanceId}-1`, instanceId, from: 3, to, reason: "manual", pinned: false, step, wasRunning: true,
	tried: [to], failures: 0, back: false, save: null, tick: null, startedAt: 0, endedAt: null, error: null,
	preflight: null, check: null,
});
/** Within a byte: the margin's 1.2 isn't exact in binary. */
const near = (actual: number, expected: number, what: string) => {
	assert.ok(Math.abs(actual - expected) < 1, `${what}: ${actual}, expected ${expected}`);
};

test("memory §3.1: need is the figure × 1.2; with none, the cluster's largest × 1.2; none at all, 1 GiB × 1.2", () => {
	const figures = { 7: GIB, 8: 2 * GIB };
	near(need(figures, 7), 1.2 * GIB, "its own");
	near(need(figures, 9), 2.4 * GIB, "no figure: the largest (Review Focus 3)");
	near(need(figures, null), 2.4 * GIB, "a new tile");
	near(need({}, null), 1.2 * GIB, "no figure anywhere");
});

test("memory §3.2: room is limit% × capacity − max(used, Σ need); each host's own limit, 90 unreported", () => {
	near(room(facts(), 1, null), 5 * GIB, "9 GiB at 90 %, 4 GiB used, no tiles");
	near(room(facts({ limits: new Map([[1, 50]]) }), 1, null), GIB, "host 1's own limit");
	near(room(facts({ limits: new Map([[1, 50]]) }), 2, null), 5 * GIB, "host 2 hasn't reported: 90");
	const f = facts({
		figures: { 7: 2 * GIB, 8: 2 * GIB, 9: 2 * GIB, 10: 2 * GIB, 11: 2 * GIB },
		tiles: [
			{ id: 7, host: 1, status: "running" }, { id: 8, host: 1, status: "starting" },
			{ id: 10, host: 1, status: "stopped" }, { id: 9, host: 3, status: "running" },
			{ id: 11, host: 3, status: "running" },
		],
		moves: [arriving(9, 1, "preflight"), arriving(7, 1), { ...arriving(11, 1), step: "done", endedAt: 1 }],
	});
	near(room(f, 1, null), 1.8 * GIB,
		"7 (running, and moving there: once), 8 (starting) and 9 (its pre-flight) at 2.4 GiB beat 4 GiB used; " +
		"10 is stopped and 11's move ended");
	near(room(f, 1, 7), 4.2 * GIB, "T itself never counts");
	near(room(f, 1, 9), 4.2 * GIB, "nor does T's own move");
});

test("memory §3.2: without a reading 60 s old or newer a host has no room and is never over its limit", () => {
	const f = facts({ memory: h => (h === 3 ? undefined : reading(9.5, h === 1 ? 60_000 : 60_001)) });
	near(room(f, 1, null), -0.5 * GIB, "60 s old still counts: 9.5 GiB used of a 9 GiB limit");
	assert.equal(overLimit(f, 1), true);
	assert.equal(room(f, 2, null), 0, "older than 60 s: none (Review Focus 1)");
	assert.equal(overLimit(f, 2), false, "so its memory timer clears");
	assert.equal(room(f, 3, null), 0, "no reading at all");
	assert.deepEqual([usedPct(f, 2), usedPct(f, 3), overLimit(f, 3)], [null, null, false]);
	assert.equal(noRoom(f, null, 2), "host 2 has sent no memory reading in 60 s");
	assert.equal(noRoom(f, null, 3), "host 3 has sent no memory reading in 60 s");
});

test("memory §3.5: over the limit is above it; exactly at it is not (MR9, Review Focus 4)", () => {
	const f = facts({ memory: h => reading(h === 1 ? 9 : 9.01) });
	assert.deepEqual([usedPct(f, 1), overLimit(f, 1)], [90, false]);
	assert.equal(overLimit(f, 2), true);
	assert.equal(overLimit(facts({ memory: () => reading(9.01), limits: new Map([[1, 95]]) }), 1), false,
		"its own limit");
});

test("memory §3.3, M5: noRoom says why a tile doesn't fit, in MB", () => {
	const f = facts({ figures: { 7: GIB } });
	assert.equal(noRoom(f, 7, 1), undefined, "1.2 GiB need, 5 GiB room");
	assert.equal(noRoom(facts({ figures: { 7: Math.floor(5 * GIB / 1.2) } }), 7, 1), undefined, "need = room fits");
	f.limits.set(1, 50);
	assert.equal(noRoom(f, 7, 1), "host 1 has room for 1024 MB, it needs 1229 MB");
	f.limits.set(1, 10);
	assert.equal(noRoom(f, 7, 1), "host 1 has room for 0 MB, it needs 1229 MB", "over its limit: no room");
});

test("memory §3.4, M4: a host without room is dropped from tier 1 and from tier 2", () => {
	const hosts = [
		host(1, { speed: 0.5 }), host(2, { speed: 0.9, slots: 1 }), host(3, { speed: 0.4, slots: 1 }),
		host(4, { speed: 0.2, slots: 1 }), host(5, { speed: 0.6, slots: 3 }),
	];
	const tiles = [
		{ id: 20, host: 2, status: "running" }, { id: 30, host: 3, status: "running" },
		{ id: 40, host: 4, status: "running" },
	];
	const ups: Record<number, number> = { 20: 50, 30: 55, 40: 40 };
	const last = (id: number) => ({ at: 1, ups: ups[id], ms: null });
	const ms = () => 3;
	assert.deepEqual(failoverCandidates(1, hosts, tiles, last, ms, 58, 45, 2), [5, 3, 2]);
	assert.deepEqual(failoverCandidates(1, hosts, tiles, last, ms, 58, 45, 2, h => h !== 5 && h !== 3), [2],
		"5 (tier 1) and 3 (tier 2) have no room: best effort never overrides it");
});

test("memory §3.5: no bounce-back: T moved off S over its limit doesn't fit back, and H stays 0.2 × T under", () => {
	// S (host 1): 9.5 GiB used, over its 9 GiB limit, with T (7, figure 2 GiB) and U (8, 1 GiB). H (host 2): 6.5 GiB.
	const used: Record<number, number> = { 1: 9.5, 2: 6.5 };
	const tiles = [{ id: 7, host: 1, status: "running" }, { id: 8, host: 1, status: "running" }];
	const f = facts({ figures: { 7: 2 * GIB, 8: GIB }, tiles, memory: h => reading(used[h]) });
	assert.equal(overLimit(f, 1), true);
	assert.equal(noRoom(f, 7, 2), undefined, "T fits on H: 2.4 GiB need, 2.5 GiB room");
	// The move; T's actual use is its figure.
	tiles[0].host = 2;
	used[1] -= 2;
	used[2] += 2;
	assert.equal(noRoom(f, 7, 1), "host 1 has room for 1536 MB, it needs 2458 MB", "S's 7.5 GiB leaves 1.5 GiB");
	assert.equal(overLimit(f, 2), false);
	assert.ok(room(f, 2, null) >= 0.2 * 2 * GIB, "H is under its limit by 0.2 × T's figure or more");
});

test("memory §3.6, M1: accepts is false while draining, false without room for a new tile, true otherwise", () => {
	const f = facts({ figures: { 7: GIB } });
	assert.equal(accepts(f, [], 1), true, "a new tile needs 1.2 GiB of 5");
	assert.equal(accepts(f, [1], 1), false, "draining");
	assert.equal(accepts(facts({ figures: { 7: 5 * GIB } }), [], 1), false,
		"a new tile needs 6 GiB: the largest × 1.2");
});
