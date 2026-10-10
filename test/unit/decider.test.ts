import { test } from "node:test";
import assert from "node:assert/strict";
import type { Move } from "../../contracts.js";
import {
	applyCheck, benchmarksDue, decide, drainMoves, dueChecks, memoryTimers, overloadMoves, recheckMoves, type Tile,
	type View,
} from "../../decider.js";
import { emptyState } from "../../state.js";
import { Telemetry } from "../../telemetry.js";

const MIN = 60_000;
const NOW = 100 * MIN;

/** A cluster at NOW: hosts 1–3 connected, no tiles, no moves, no samples. */
function view(over: Partial<View> = {}): View {
	return {
		now: NOW, connected: [1, 2, 3], tiles: [], moves: [], draining: [], benchmarking: new Set(),
		telemetry: new Telemetry(() => NOW), speed: () => null, floor: 58, busyMs: 2, lagMs: 3 * MIN,
		checkMs: 10 * MIN, fits: () => true, memoryHigh: [], figure: () => undefined, ...over,
	};
}
const tile = (id: number, host: number, extra: Partial<Tile> = {}): Tile => (
	{ id, host, status: "running", players: 0, hasCopy: true, ...extra }
);
/** Five minutes of 10-s samples ending at NOW, each at `ups` and `ms` CPU ms per tick. */
function samples(v: View, id: number, ups: number, ms: number) {
	v.telemetry.add(id, Array.from({ length: 30 }, (_, i) => ({ at: NOW - (29 - i) * 10_000, ups, ms })));
}
/** A manual move of 7 from host 1 to host 2 that ended 10 minutes ago, unchecked. */
const move = (over: Partial<Move> = {}): Move => ({
	id: "7-1", instanceId: 7, from: 1, to: 2, reason: "manual", pinned: false, step: "done", wasRunning: true,
	tried: [2], failures: 0, back: false, save: "balancer.zip", tick: 100, startedAt: 0, endedAt: NOW - 10 * MIN,
	error: null, preflight: { msPerTick: 3, minUps: 60, busy: 2 }, check: null, ...over,
});
const failedCheck = { at: NOW, ups: 50, ms: 3, othersMinUps: 60, ok: false };
const slowedCheck = { ...failedCheck, ups: 59, othersMinUps: 55 };

test("rule priority (§4.3 unit 3, R1): the first rule with work takes the pass; disabled, only drain runs (P4)", () => {
	const v = view({
		draining: [1],
		tiles: [tile(10, 1), tile(20, 2), tile(21, 2), tile(30, 3)],
		moves: [move({ instanceId: 30, to: 3, check: failedCheck })],
	});
	samples(v, 20, 50, 4); // host 2: two busy tiles, one lagging
	samples(v, 21, 60, 3);
	const fo = { instanceId: 99, from: 9, reason: "failover" as const, wasRunning: true };
	assert.deepEqual(decide(v, [fo], true), { rule: "failover", add: [fo], beyond: [] });
	const drain = decide(v, [], true);
	assert.deepEqual([drain.rule, drain.add.map(a => a.instanceId)], ["drain", [10]]);
	v.moves.push(move({ id: "f", instanceId: 98, reason: "failover", step: "assign" }));
	assert.deepEqual(decide(v, [], true), { rule: "failover", add: [], beyond: [] }, "an unfinished failover holds it");
	v.moves.pop();
	v.draining = [];
	const overload = decide(v, [], true);
	assert.deepEqual([overload.rule, overload.add.map(a => a.instanceId)], ["overload", [20]]);
	v.telemetry = new Telemetry(() => NOW); // nothing lags now
	const recheck = decide(v, [], true);
	assert.deepEqual([recheck.rule, recheck.add], ["after_check", [
		{ instanceId: 30, from: 3, reason: "after_check", wasRunning: true },
	]]);
	assert.equal(decide(v, [], false).rule, null, "disabled: no overload, no re-move");
	v.draining = [1];
	assert.equal(decide(v, [], false).rule, "drain", "disabled: drain still runs");
});

test("drain (§5.4, R12): one at a time per host; occupied tiles wait, failed ones wait 10 minutes", () => {
	const v = view({
		draining: [1],
		tiles: [
			tile(10, 1, { players: 1 }), tile(11, 1, { hasCopy: false }),
			tile(12, 1, { status: "stopped", hasCopy: false }), tile(13, 1), tile(20, 2),
		],
	});
	assert.deepEqual(drainMoves(v), [{ instanceId: 12, from: 1, reason: "drain", wasRunning: false }],
		"10 is occupied; 11 has no copy to pre-flight; 12 is stopped and needs none");
	v.moves.push(move({ instanceId: 12, reason: "drain", step: "pull" }));
	assert.deepEqual(drainMoves(v), [], "one at a time");
	v.moves[0] = move({ instanceId: 12, reason: "drain", step: "failed", endedAt: NOW - MIN });
	assert.deepEqual(drainMoves(v).map(a => a.instanceId), [13], "12 failed a minute ago: the next one goes");
	v.moves[0].endedAt = NOW - 11 * MIN;
	assert.deepEqual(drainMoves(v).map(a => a.instanceId), [12], "and 12 is tried again after 10 minutes");
	v.moves[0] = move({ instanceId: 12, reason: "drain", back: true, endedAt: NOW - MIN });
	assert.deepEqual(drainMoves(v).map(a => a.instanceId), [13], "12 came back a minute ago: it waits too");
	v.moves[0].endedAt = NOW - 11 * MIN;
	assert.deepEqual(drainMoves(v).map(a => a.instanceId), [12]);
	v.connected = [2, 3];
	assert.deepEqual(drainMoves(v), [], "a disconnected draining host waits (failover's, after the grace)");
});

test("overload (§5.5): a lagging host moves its heaviest empty tile, once per host per 10 minutes", () => {
	const v = view({ tiles: [tile(10, 1), tile(11, 1, { players: 2 }), tile(12, 1), tile(20, 2)] });
	samples(v, 10, 50, 3); // lagging, busy
	samples(v, 11, 60, 9); // the heaviest, but occupied
	samples(v, 12, 60, 4); // the heaviest empty one
	samples(v, 20, 60, 9); // host 2 is fine
	assert.deepEqual(overloadMoves(v), {
		add: [{ instanceId: 12, from: 1, reason: "overload", wasRunning: true }], beyond: [],
	});
	v.moves.push(move({ instanceId: 12, reason: "overload", startedAt: NOW - 9 * MIN }));
	assert.deepEqual(overloadMoves(v).add, [], "host 1's last overload move began 9 minutes ago");
	v.moves[0].startedAt = NOW - 10 * MIN;
	assert.deepEqual(overloadMoves(v).add.map(a => a.instanceId), [12]);
	v.moves[0].step = "pull";
	v.moves[0].endedAt = null;
	assert.deepEqual(overloadMoves(v).add, [], "an unfinished overload move older than 10 minutes still blocks");
	v.moves.pop();
	v.benchmarking.add(1);
	assert.deepEqual(overloadMoves(v).add, [], "a benchmarking host's lag is the benchmark's (R11)");
});

test("a tile that lags as its host's only busy tile is beyond that host: named, not moved (§5.5, R16)", () => {
	const v = view({ tiles: [tile(10, 1), tile(11, 1)] });
	samples(v, 10, 50, 12);
	samples(v, 11, 60, 0.5);
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [{ host: 1, instance: 10 }] });
	const w = view({ tiles: [tile(10, 1), tile(11, 1)] });
	samples(w, 10, 60, 12);
	samples(w, 11, 50, 0.5); // a light tile lags next to the busy one: the busy one is the heaviest empty tile
	assert.deepEqual(overloadMoves(w).add.map(a => a.instanceId), [10]);
});

test("a lone lagging tile moves to a faster benchmarked host that predicts it under budget (R16)", () => {
	const speeds: Record<number, number> = { 1: 1, 2: 0.5 };
	const speed = (h: number) => speeds[h] ?? null;
	const lone = (players = 0) => {
		const v = view({ tiles: [tile(10, 1, { players })], speed });
		samples(v, 10, 50, 12); // 12 ms on speed 1 predicts 6 ms on speed 0.5, under 1000 / 58
		return v;
	};
	assert.deepEqual(overloadMoves(lone()), {
		add: [{ instanceId: 10, from: 1, reason: "overload", wasRunning: true }], beyond: [],
	});
	delete speeds[2];
	assert.deepEqual(overloadMoves(lone()), { add: [], beyond: [{ host: 1, instance: 10 }] }, "no faster host");
	speeds[2] = 0.5;
	delete speeds[1];
	assert.deepEqual(overloadMoves(lone()).beyond.length, 1, "unbenchmarked source");
	speeds[1] = 1;
	assert.deepEqual(overloadMoves(lone(1)), { add: [], beyond: [{ host: 1, instance: 10 }] }, "players on it");
});

test("the after-check (§5.6, R9): due at +after_check_minutes; T's mean UPS and its neighbours' lowest", () => {
	const v = view({ tiles: [tile(7, 2), tile(8, 2), tile(9, 3)] });
	samples(v, 7, 59, 3);
	samples(v, 8, 60, 1);
	const due = move();
	const elsewhere = move({ id: "else", instanceId: 9 }); // 9 runs on host 3, not on its move's target
	v.moves.push(
		due, move({ id: "early", endedAt: NOW - 9 * MIN }), move({ id: "fo", reason: "failover" }),
		move({ id: "stopped", wasRunning: false }), move({ id: "back", back: true, to: 1 }), elsewhere,
	);
	assert.deepEqual(dueChecks(v), [
		{ move: due, check: { at: NOW, ups: 59, ms: 3, othersMinUps: 60, ok: true } },
		{ move: elsewhere, check: { at: NOW, ups: null, ms: null, othersMinUps: null, ok: null } },
	]);
	v.telemetry.add(8, [{ at: NOW - 5_000, ups: 57.9, ms: 1 }]);
	assert.equal(dueChecks(v)[0].check.ok, false, "a neighbour dropped below the floor");
});

test("the check window is the telemetry retention: a dip in the move's first minutes isn't judged (R9)", () => {
	const v = view({ tiles: [tile(7, 2), tile(8, 2)], moves: [move()] });
	v.telemetry.add(8, [{ at: NOW - 6 * MIN, ups: 20, ms: 1 }]); // T's map load stalled its neighbour, 4 minutes in
	samples(v, 7, 60, 3);
	samples(v, 8, 60, 1);
	assert.equal(dueChecks(v)[0].check.ok, true);
});

test("a failed after-check marks (T, H) bad and lowers H's slots to the busy tiles it carried (§5.6, R10)", () => {
	const s = emptyState();
	s.hosts[2] = { bench: { speed: 0.5, slots: 4, version: "2.1.21", ref: "tile:1", at: 0 } };
	const m = move();
	assert.equal(applyCheck(m, slowedCheck, s, NOW, 24 * 60 * MIN, 58), 2);
	assert.deepEqual([m.check, s.bad["7:2"], s.hosts[2].learned], [slowedCheck, NOW + 24 * 60 * MIN, 2]);
	const more = move({ preflight: { msPerTick: 3, minUps: 60, busy: 3 } });
	assert.equal(applyCheck(more, slowedCheck, s, NOW, 1, 58), 2, "slots are never raised");
	const s2 = emptyState();
	assert.equal(applyCheck(move(), { ...slowedCheck, ok: true }, s2, NOW, 1, 58), undefined);
	assert.deepEqual([s2.bad, s2.hosts], [{}, {}], "a pass changes nothing");
});

test("a failed after-check moves T again once it's empty, and only once (§5.6)", () => {
	const v = view({ tiles: [tile(7, 2, { players: 1 })], moves: [move({ check: failedCheck })] });
	assert.deepEqual(recheckMoves(v), [], "occupied: it waits");
	v.tiles[0].players = 0;
	assert.deepEqual(recheckMoves(v), [{ instanceId: 7, from: 2, reason: "after_check", wasRunning: true }]);
	v.moves.push(move({ id: "7-2", from: 2, to: null, reason: "after_check", step: "failed" }));
	assert.deepEqual(recheckMoves(v), [], "its re-move was tried");
});

test("a failed after-check where only T lagged marks the pair bad but leaves H's slots (S3)", () => {
	const s = emptyState();
	assert.equal(applyCheck(move(), failedCheck, s, NOW, 1000, 58), undefined);
	assert.deepEqual([s.bad["7:2"], s.hosts], [NOW + 1000, {}]);
	const alone = { ...failedCheck, othersMinUps: null };
	assert.equal(applyCheck(move(), alone, s, NOW, 1000, 58), undefined, "no neighbours");
	assert.deepEqual(s.hosts, {});
});

test("a host whose drain found no eligible target is left alone for 10 minutes (S4)", () => {
	const v = view({ draining: [1], tiles: [tile(10, 1), tile(11, 1)] });
	v.moves.push(move({
		instanceId: 10, reason: "drain", step: "failed", to: null, error: "no eligible target", endedAt: NOW - 9 * MIN,
	}));
	assert.deepEqual(drainMoves(v), [], "no target 9 minutes ago: nothing for the host, not even tile 11");
	v.moves[0].endedAt = NOW - 11 * MIN;
	assert.deepEqual(drainMoves(v).map(a => a.instanceId), [10]);
	v.moves[0].error = "every target failed its pre-flight";
	v.moves[0].endedAt = NOW - MIN;
	assert.deepEqual(drainMoves(v).map(a => a.instanceId), [11], "other failures skip only the tile (R12)");
});

test("a check whose window is gone stays unjudged (M2)", () => {
	const v = view({ tiles: [tile(7, 2)] });
	samples(v, 7, 60, 3);
	v.moves.push(move({ endedAt: NOW - 15 * MIN - 1 }), move({ id: "edge", endedAt: NOW - 15 * MIN }));
	assert.deepEqual(dueChecks(v).map(d => d.move.id), ["edge"], "past endedAt + checkMs + retention: skipped");
});

test("the join benchmark runs automatically only on a quiet host with no current result (R3, Review Focus 2)", () => {
	const v = view({
		connected: [1, 2, 3, 4, 5],
		tiles: [
			tile(10, 2), tile(20, 3, { status: "unknown" }), tile(30, 4, { status: "stopped" }),
			tile(50, 5, { status: "stopped" }),
		],
		moves: [move({ instanceId: 50, from: 5, to: 1, step: "preflight" })],
	});
	const versions = new Map([1, 2, 3, 4, 5].map((h): [number, string] => [h, "2.1.21"]));
	const hosts = { 4: { bench: { speed: 0.5, slots: 4, version: "2.1.21", ref: "tile:7", at: 0 } } };
	assert.deepEqual(benchmarksDue(v, versions, hosts, "tile:7", () => false), [],
		"1 and 5: a move; 2: a running tile; 3: an unknown one (a restart); 4: its result is current");
	assert.deepEqual(benchmarksDue(v, versions, hosts, "file:/ref.zip", () => false), [4], "a new reference");
	versions.set(4, "2.1.22");
	assert.deepEqual(benchmarksDue(v, versions, hosts, "tile:7", () => false), [4], "a new Factorio");
	v.moves = [];
	assert.deepEqual(benchmarksDue(v, versions, hosts, "tile:7", h => h === 4), [1, 5], "skip: running or failed now");
	versions.delete(1);
	assert.deepEqual(benchmarksDue(v, versions, hosts, "tile:7", () => false), [4, 5], "1 hasn't reported a version");
	v.draining = [5];
	assert.deepEqual(benchmarksDue(v, versions, hosts, "tile:7", () => false), [4], "M5: a draining host waits");
});

const GIB = 2 ** 30;

test("memory §3.5 (M8): over its limit, a host moves its largest empty tile that fits elsewhere, reason memory", () => {
	const figures: Record<number, number> = { 10: 4 * GIB, 11: 3 * GIB, 12: 2 * GIB, 13: GIB };
	const v = view({
		tiles: [tile(10, 1), tile(11, 1, { players: 1 }), tile(12, 1), tile(13, 1), tile(20, 2)],
		memoryHigh: [1],
		figure: id => figures[id],
		fits: id => id !== 10, // the largest fits on no other host
	});
	assert.deepEqual(overloadMoves(v), {
		add: [{ instanceId: 12, from: 1, reason: "memory", wasRunning: true }], beyond: [],
	}, "10 fits nowhere and 11 is occupied: 12 is the largest that can go");
	v.fits = () => false;
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [{ host: 1, instance: null }] }, "none can go: no_move");
	v.fits = (_id, h) => h === 1;
	assert.deepEqual(overloadMoves(v).beyond, [{ host: 1, instance: null }], "fitting on its own host doesn't count");
	v.fits = () => true;
	v.draining = [2, 3];
	assert.deepEqual(overloadMoves(v).beyond, [{ host: 1, instance: null }], "draining hosts aren't open");
	v.draining = [];
	v.memoryHigh = [];
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [] }, "not over its limit for lag_minutes: nothing");
});

test("memory §3.5: a tile with no figure yet goes after every measured one (Review Focus 3)", () => {
	const v = view({ tiles: [tile(10, 1), tile(11, 1)], memoryHigh: [1], figure: id => (id === 11 ? GIB : undefined) });
	assert.deepEqual(overloadMoves(v).add.map(a => a.instanceId), [11]);
});

test("memory §3.5: memory comes first and shares the 10-minute limit; its moves hold the overload slot (MR8)", () => {
	const v = view({
		tiles: [tile(10, 1), tile(11, 1)], memoryHigh: [1], figure: id => (id === 10 ? 2 * GIB : GIB),
	});
	samples(v, 10, 50, 3); // lagging
	samples(v, 11, 60, 4); // the heaviest by CPU: the lag trigger alone would move 11
	assert.deepEqual(overloadMoves(v).add, [{ instanceId: 10, from: 1, reason: "memory", wasRunning: true }],
		"one move, the memory one: the largest figure");
	v.moves.push(move({ instanceId: 10, reason: "memory", startedAt: NOW - 9 * MIN }));
	assert.deepEqual(overloadMoves(v).add, [], "a memory move 9 minutes ago");
	v.memoryHigh = [];
	assert.deepEqual(overloadMoves(v).add, [], "holds the lag trigger too");
	v.moves[0].reason = "overload";
	v.memoryHigh = [1];
	assert.deepEqual(overloadMoves(v).add, [], "and an overload move holds the memory trigger");
	v.moves[0].startedAt = NOW - 10 * MIN;
	assert.deepEqual(overloadMoves(v).add.map(a => a.reason), ["memory"], "10 minutes on");
	v.moves[0] = move({ instanceId: 10, reason: "memory", step: "pull", endedAt: null });
	assert.deepEqual(decide(v, [], true), { rule: "overload", add: [], beyond: [] },
		"an unfinished memory move holds the overload rule's slot");
	assert.equal(decide(v, [], false).rule, null, "P4: disabled, no memory moves");
});

test("memory §3.5: the timer: over the limit for lag_minutes; a pass at or under it (or stale) clears it", () => {
	const since = new Map<number, number>();
	assert.deepEqual(memoryTimers(since, [1, 2], NOW, 3 * MIN), [], "first seen over");
	assert.deepEqual(memoryTimers(since, [1, 2], NOW + 3 * MIN - 1, 3 * MIN), [], "under 3 minutes");
	assert.deepEqual(memoryTimers(since, [1], NOW + 3 * MIN, 3 * MIN), [1], "3 minutes; 2 read at or under its limit");
	assert.deepEqual([...since.keys()], [1], "2's timer is cleared");
	assert.deepEqual(memoryTimers(since, [1, 2], NOW + 4 * MIN, 3 * MIN), [1], "2 starts again from 0");
});

test("M6: a lone lagging tile moves only to a faster host it fits on; else it is beyond", () => {
	const speeds: Record<number, number> = { 1: 1, 2: 0.5 };
	const v = view({ tiles: [tile(10, 1)], speed: h => speeds[h] ?? null });
	samples(v, 10, 50, 12);
	assert.deepEqual(overloadMoves(v).add.map(a => a.instanceId), [10]);
	v.fits = (_id, h) => h !== 2;
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [{ host: 1, instance: 10 }] }, "the faster host has no room");
});
