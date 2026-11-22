import { test } from "node:test";
import assert from "node:assert/strict";
import type { Move } from "../../contracts.js";
import {
	accepts, candidates, failoverCandidates, need, noRoom, offered, overLimit, room, roomable, usedPct, verdict,
	type HostFact, type HostMemory, type MemoryFacts,
} from "../../targets.js";

const host = (id: number, extra: Partial<HostFact> = {}): HostFact => (
	{ id, open: true, cores: 8, cap: null, ...extra }
);

test("capacity C1, C2: open hosts but the source, none lagging; by all-thread CPU ms per core, then id", () => {
	const hosts = [
		host(1), // the source
		host(2), // 12 ms on 8 cores: 1.5
		host(3, { cores: 16 }), // 16 ms on 16 cores: 1
		host(4, { open: false }), // disconnected or draining
		host(5), // a tile under the floor
		host(6), // nothing running: 0
		host(7, { cores: null }), // no core count yet
		host(8), // a running tile with no figure
		host(9), // 12 ms on 8 cores: ties with 2
	];
	const on = (h: number, ...ids: number[]) => ids.map(id => ({ id, host: h, status: "running" }));
	const tiles = [
		...on(2, 20, 21), ...on(3, 30), ...on(5, 50), { id: 60, host: 6, status: "stopped" }, ...on(8, 80, 81),
		...on(9, 90),
	];
	const ms: Record<number, number> = { 20: 8, 21: 4, 30: 16, 50: 1, 60: 99, 80: 1, 90: 12 };
	const last = (id: number) => ({ at: 1, ups: id === 50 ? 57 : 60, ms: null });
	assert.deepEqual(candidates(1, hosts, tiles, last, id => ms[id], 58), [6, 3, 2, 9, 7, 8]);
});

test("a stopped tile's low UPS doesn't block its host", () => {
	const hosts = [host(1), host(2)];
	const tiles = [{ id: 20, host: 2, status: "stopped" }];
	const last = () => ({ at: 1, ups: 10, ms: null });
	assert.deepEqual(candidates(1, hosts, tiles, last, () => undefined, 58), [2]);
});

test("capacity C2: tiles moving to a host count at their last figure, each once", () => {
	const hosts = [host(1), host(2)];
	const tiles = [
		{ id: 10, host: 1, status: "running" }, { id: 20, host: 2, status: "running" },
		{ id: 30, host: 3, status: "running" },
	];
	const ms: Record<number, number> = { 10: 4, 20: 3, 30: 5 };
	const rank = (arriving?: (h: number) => number[]) => (
		candidates(null, hosts, tiles, () => undefined, id => ms[id], 58, undefined, arriving)
	);
	assert.deepEqual(rank(), [2, 1]);
	assert.deepEqual(rank(h => (h === 2 ? [20, 30] : [])), [1, 2], "30 is on its way to 2: 8 ms there; 20 once");
	assert.deepEqual(rank(h => (h === 2 ? [31] : [])), [2, 1], "an arrival with no figure counts 0");
});

test("capacity C3: a capped host is eligible only while it runs fewer tiles than its cap", () => {
	const tiles = [{ id: 10, host: 1, status: "running" }, { id: 11, host: 1, status: "running" }];
	const rank = (cap: number) => candidates(null, [host(1, { cap })], tiles, () => undefined, () => 1, 58);
	assert.deepEqual([rank(2), rank(3)], [[], [1]]);
});

test("the pre-flight verdict (capacity C4: the controller passes 1000 / failover_floor as the ms line)", () => {
	assert.equal(verdict(5, 60, 10, 58, true), true);
	assert.equal(verdict(12, 60, 10, 58, true), false);
	assert.equal(verdict(5, 40, 10, 58, true), false);
	assert.equal(verdict(5, null, 10, 58, false), true);
	assert.equal(verdict(5, null, 10, 58, true), false);
});

test("fits drops a host", () => {
	assert.deepEqual(candidates(null, [host(1), host(2)], [], () => undefined, () => undefined, 58, h => h !== 1), [2]);
});

test("failover: eligible hosts first, then the others by their lowest UPS, then load; under 45 and `from` out", () => {
	const hosts = [host(1), host(2), host(3), host(4), host(5), host(6, { cap: 1 }), host(7)];
	const tiles = [20, 30, 40, 60, 70].map(id => ({ id, host: id / 10, status: "running" }));
	const ups: Record<number, number> = { 20: 50, 30: 55, 40: 40, 60: 60, 70: 50 };
	const ms: Record<number, number> = { 20: 3, 30: 3, 40: 3, 60: 3, 70: 1 };
	const last = (id: number) => ({ at: 1, ups: ups[id], ms: null });
	assert.deepEqual(failoverCandidates(1, hosts, tiles, last, id => ms[id], 58, 45), [5, 6, 3, 7, 2],
		"6 is at its cap, which tier 2 ignores (C3); 7 and 2 both sit at 50 UPS, 7 with less load; 4 is under 45");
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
	const hosts = [host(1), host(2), host(3), host(4), host(5)];
	const tiles = [
		{ id: 20, host: 2, status: "running" }, { id: 30, host: 3, status: "running" },
		{ id: 40, host: 4, status: "running" },
	];
	const ups: Record<number, number> = { 20: 50, 30: 55, 40: 40 };
	const last = (id: number) => ({ at: 1, ups: ups[id], ms: null });
	const ms = () => 3;
	assert.deepEqual(failoverCandidates(1, hosts, tiles, last, ms, 58, 45), [5, 3, 2]);
	assert.deepEqual(failoverCandidates(1, hosts, tiles, last, ms, 58, 45, h => h !== 5 && h !== 3), [2],
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

test("capacity C8: a marked host isn't offered; a failover or drain takes one with no unmarked host left", () => {
	const marked = (h: number) => h === 2 || h === 5;
	const none = () => false;
	assert.deepEqual(offered([2, 3, 5, 4], marked, none, false), [3, 4], "an overload or memory move");
	assert.deepEqual(offered([2, 3, 5, 4], marked, none, true), [3, 4], "unmarked hosts are eligible: only those");
	const bad = (h: number) => h === 3 || h === 5;
	assert.deepEqual(offered([2, 3, 5], marked, bad, true), [2], "3 failed its pre-flight: the marked host is left");
	assert.deepEqual(offered([2, 3, 5], marked, bad, false), [], "never, for any other move");
	assert.deepEqual(offered([], marked, none, true), []);
});

test("capacity C7: room counts the reserved tile on its host for every other tile; not once expired", () => {
	const reserve = { instanceId: 7, host: 1, until: NOW + 1 };
	const f = facts({ figures: { 7: 5 * GIB }, memory: () => reading(1), reserve });
	near(room(f, 1, null), 3 * GIB, "9 GiB less 7's 6 GiB need, though 7 isn't there yet");
	near(room(f, 1, 8), 3 * GIB, "for any other tile");
	near(room(f, 1, 7), 8 * GIB, "not for the tile itself");
	near(room(f, 2, null), 8 * GIB, "nor on another host");
	assert.equal(accepts(f, [], 1), false, "a new tile needs 6 GiB too: gridworld places none there");
	f.reserve = { ...reserve, until: NOW };
	near(room(f, 1, null), 8 * GIB, "past its until it counts for nothing");
	assert.equal(accepts(f, [], 1), true);
});

test("capacity C5, C7 step 1: a short host is tested only within its available bytes, if room can be made", () => {
	const tiles = [{ id: 20, host: 1, status: "running" }, { id: 21, host: 1, status: "running" }];
	const f = facts({ figures: { 7: 5 * GIB, 20: 2 * GIB, 21: GIB }, tiles });
	assert.equal(noRoom(f, 7, 1), "host 1 has room for 5120 MB, it needs 6144 MB");
	assert.equal(roomable(f, 7, 1, [21]), true, "6 GiB available; 5 GiB of room and 21's 1.2 GiB cover 6 GiB");
	assert.equal(roomable(f, 7, 1, []), false, "step 1: no empty tile there has a target");
	f.memory = () => reading(4.5);
	assert.equal(roomable(f, 7, 1, [20, 21]), false, "5.5 GiB available: the test's copy wouldn't fit");
	f.memory = () => reading(4, 60_001);
	assert.equal(roomable(f, 7, 1, [20, 21]), false, "no fresh reading");
});

test("capacity C7 step 1: where `used` binds, a tile that leaves frees its figure, not its need", () => {
	// Host 1: 5 GiB limit, 4.5 used: 0.5 of room. Three empty tiles of figure 1 GiB. T (7): figure 3.3 GiB, need 3.96.
	const tiles = [20, 21, 22].map(id => ({ id, host: 1, status: "running" }));
	const f = facts({ figures: { 7: 3.3 * GIB, 20: GIB, 21: GIB, 22: GIB }, tiles, memory: () => reading(4.5) });
	f.limits.set(1, 50);
	assert.equal(roomable(f, 7, 1, [20, 21, 22]), false, "0.5 + 3 × 1.2 would say 4.1: all three free 3, so 3.5");
	f.figures[7] = 2.8 * GIB;
	assert.equal(roomable(f, 7, 1, [20, 21, 22]), true, "a need of 3.36 fits in 3.5");
});

test("capacity C7 step 1: a leaving tile with no recorded figure frees nothing of `used`", () => {
	// As above, but 22 has no figure: need() would stand in T's 2.8 GiB for it, which no eviction gives back.
	const tiles = [20, 21, 22].map(id => ({ id, host: 1, status: "running" }));
	const f = facts({ figures: { 7: 2.8 * GIB, 20: GIB, 21: GIB }, tiles, memory: () => reading(4.5) });
	f.limits.set(1, 50);
	assert.equal(roomable(f, 7, 1, [20, 21, 22]), false, "0.5 + 1 + 1 = 2.5 is short of a 3.36 need");
});

test("capacity C7, the two-host limit: an evicted tile's only target is the lagging tile's host: ineligible", () => {
	const tiles = [{ id: 7, host: 1, status: "running" }, { id: 20, host: 2, status: "running" }];
	const last = (id: number) => ({ at: 1, ups: id === 7 ? 50 : 60, ms: null });
	assert.deepEqual(candidates(2, [host(1), host(2)], tiles, last, () => 1, 58), [], "so step 1 finds none evictable");
	assert.deepEqual(candidates(2, [host(1), host(2), host(3)], tiles, last, () => 1, 58), [3]);
});
