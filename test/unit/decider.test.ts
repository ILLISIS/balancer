import { test } from "node:test";
import assert from "node:assert/strict";
import type { Move } from "../../contracts.js";
import {
	applyCheck, clearMarks, decide, drainMoves, dueChecks, markOf, memoryTimers, overloadMoves, recheckMoves,
	type Tile, type View,
} from "../../decider.js";
import { emptyState } from "../../state.js";
import { Telemetry } from "../../telemetry.js";

const MIN = 60_000;
const NOW = 100 * MIN;

/** A cluster at NOW: hosts 1–3 connected, no tiles, no moves, no samples. */
function view(over: Partial<View> = {}): View {
	return {
		now: NOW, connected: [1, 2, 3], tiles: [], moves: [], draining: [], telemetry: new Telemetry(() => NOW),
		floor: 58, lagMs: 3 * MIN, checkMs: 10 * MIN, fits: () => true, memoryHigh: [], figure: () => undefined,
		marked: () => false, bad: () => false, ...over,
	};
}
const tile = (id: number, host: number, extra: Partial<Tile> = {}): Tile => (
	{ id, host, status: "running", players: 0, hasCopy: true, ...extra }
);
/** Five minutes of 10-s samples ending at NOW, each at `ups`, `ms` CPU ms per tick and `mainMs` on the main thread. */
function samples(v: View, id: number, ups: number, ms: number, mainMs?: number) {
	v.telemetry.add(id, Array.from({ length: 30 }, (_, i) => ({ at: NOW - (29 - i) * 10_000, ups, ms, mainMs })));
}
/** A manual move of 7 from host 1 to host 2 that ended 10 minutes ago, unchecked. */
const move = (over: Partial<Move> = {}): Move => ({
	id: "7-1", instanceId: 7, from: 1, to: 2, reason: "manual", pinned: false, step: "done", wasRunning: true,
	tried: [2], failures: 0, back: false, save: "balancer.zip", tick: 100, startedAt: 0, endedAt: NOW - 10 * MIN,
	error: null, preflight: { msPerTick: 3, minUps: 60, tiles: 2 }, check: null, ...over,
});
const failedCheck = { at: NOW, ups: 50, ms: 3, othersMinUps: 60, ok: false };
const slowedCheck = { ...failedCheck, ups: 59, othersMinUps: 55 };

test("rule priority (§4.3 unit 3, R1): the first rule with work takes the pass; disabled, only drain runs (P4)", () => {
	const v = view({
		draining: [1],
		tiles: [tile(10, 1), tile(20, 2), tile(21, 2), tile(30, 3)],
		moves: [move({ instanceId: 30, to: 3, check: failedCheck })],
	});
	samples(v, 20, 50, 4); // host 2: its only lagging tile, and empty
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

test("overload (§5.5, capacity C5): two or more lagging, the heaviest empty tile by main-thread ms; 10 minutes", () => {
	const v = view({ tiles: [tile(10, 1), tile(11, 1, { players: 2 }), tile(12, 1), tile(13, 1), tile(20, 2)] });
	samples(v, 10, 50, 1.5); // lagging; no main-thread reading, so its all-thread figure orders it
	samples(v, 11, 50, 9, 9); // lagging and the heaviest, but occupied
	samples(v, 12, 60, 4, 1); // the most over all threads, the least on the main thread
	samples(v, 13, 60, 3, 2); // the heaviest empty one
	samples(v, 20, 60, 9, 9); // host 2 is fine
	assert.deepEqual(overloadMoves(v), {
		add: [{ instanceId: 13, from: 1, reason: "overload", wasRunning: true }], beyond: [],
	});
	v.moves.push(move({ instanceId: 13, reason: "overload", startedAt: NOW - 9 * MIN }));
	assert.deepEqual(overloadMoves(v).add, [], "host 1's last overload move began 9 minutes ago");
	v.moves[0].startedAt = NOW - 10 * MIN;
	assert.deepEqual(overloadMoves(v).add.map(a => a.instanceId), [13]);
	v.moves[0].step = "pull";
	v.moves[0].endedAt = null;
	assert.deepEqual(overloadMoves(v).add, [], "an unfinished overload move older than 10 minutes still blocks");
	v.moves.pop();
	v.tiles[3].players = 1;
	assert.deepEqual(overloadMoves(v).add.map(a => a.instanceId), [10], "10's 1.5 ms beats 12's main-thread 1 ms");
});

test("capacity C5, the plain rule: a host's only lagging tile moves itself when empty; occupied, a neighbour", () => {
	const lone = (players = 0) => {
		const v = view({ tiles: [tile(10, 1, { players }), tile(11, 1), tile(12, 1)] });
		samples(v, 10, 50, 1);
		samples(v, 11, 60, 9);
		samples(v, 12, 60, 4);
		return v;
	};
	assert.deepEqual(overloadMoves(lone()), {
		add: [{ instanceId: 10, from: 1, reason: "overload", wasRunning: true, measure: true }], beyond: [],
	}, "not 11, the heaviest; it is measured (C5)");
	assert.equal(overloadMoves(lone(1)).add[0].measure, undefined, "a neighbour goes by the plain rule");
	assert.deepEqual(overloadMoves(lone(1)).add.map(a => a.instanceId), [11], "occupied: its heaviest empty neighbour");
	const v = lone();
	v.moves.push(move({ instanceId: 12, reason: "overload", startedAt: NOW - 9 * MIN }));
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [] }, "under the 10-minute limit too");
});

test("M6: a host's only lagging tile, empty, that fits on no other open host is beyond: named, not moved", () => {
	const v = view({ tiles: [tile(10, 1), tile(11, 1)], fits: () => false });
	samples(v, 10, 50, 12);
	samples(v, 11, 60, 1);
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [{ host: 1, instance: 10, rule: "overload" }] });
	v.short = (id, h) => id === 10 && h === 3;
	assert.deepEqual(overloadMoves(v), {
		add: [{ instanceId: 10, from: 1, reason: "overload", wasRunning: true, measure: true }], beyond: [],
	}, "capacity C5: short of memory on host 3, but it can be tested there and room made: a candidate");
	v.bad = (_id, h) => h === 3;
	assert.equal(overloadMoves(v).add.length, 0, "not as a bad pair");
	v.bad = () => false;
	v.short = undefined;
	v.fits = () => true;
	v.draining = [2, 3];
	assert.deepEqual(overloadMoves(v).beyond, [{ host: 1, instance: 10, rule: "overload" }],
		"draining hosts aren't open");
	v.draining = [];
	assert.deepEqual(overloadMoves(v).add.map(a => a.instanceId), [10]);
});

test("the after-check (§5.6, R9, capacity C6): due at +after_check_minutes; T's mean UPS and its neighbours'", () => {
	const v = view({ tiles: [tile(7, 2), tile(8, 2), tile(6, 2), tile(9, 3)] });
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
	v.telemetry.add(8, [{ at: NOW - 5_000, ups: 40, ms: 1 }]);
	assert.equal(dueChecks(v)[0].check.ok, true, "one low sample (a player-join save) leaves 8's mean above the floor");
	samples(v, 6, 57, 1); // 6 had no sample in the window until now: skipped
	const { check } = dueChecks(v)[0];
	assert.deepEqual([check.ok, check.othersMinUps], [false, 57], "a neighbour's mean under the floor");
});

test("the check window is the telemetry retention: a dip in the move's first minutes isn't judged (R9)", () => {
	const v = view({ tiles: [tile(7, 2), tile(8, 2)], moves: [move()] });
	v.telemetry.add(8, [{ at: NOW - 6 * MIN, ups: 20, ms: 1 }]); // T's map load stalled its neighbour, 4 minutes in
	samples(v, 7, 60, 3);
	samples(v, 8, 60, 1);
	assert.equal(dueChecks(v)[0].check.ok, true);
});

test("a failed after-check marks (T, H) bad; H's other tiles slowed, so H is capped at what it carried (C3)", () => {
	const DAY = 24 * 60 * MIN;
	const s = emptyState();
	const m = move();
	assert.equal(applyCheck(m, slowedCheck, s, NOW, DAY, 58), 2);
	assert.deepEqual([m.check, s.bad["7:2"], s.hosts[2]], [
		slowedCheck, NOW + DAY, { cap: { tiles: 2, until: NOW + DAY } },
	]);
	const more = move({ preflight: { msPerTick: 3, minUps: 60, tiles: 3 } });
	assert.equal(applyCheck(more, slowedCheck, s, NOW + MIN, DAY, 58), 2, "a second failure while capped: the lower");
	assert.equal(s.hosts[2].cap?.until, NOW + MIN + DAY, "and the 24 h start again");
	assert.equal(applyCheck(more, slowedCheck, s, NOW + 2 * DAY, DAY, 58), 3, "the cap had expired: nothing ratchets");
	const s2 = emptyState();
	assert.equal(applyCheck(move(), { ...slowedCheck, ok: true }, s2, NOW, 1, 58), undefined);
	assert.deepEqual([s2.bad, s2.hosts], [{}, {}], "a pass changes nothing");
	const old = move({ preflight: { msPerTick: 3, minUps: 60 } }); // a ledger move from before the amendment
	assert.equal(applyCheck(old, slowedCheck, s2, NOW, 1, 58), undefined);
	assert.deepEqual(s2.hosts, {}, "no tile count: the pair is bad, the host uncapped");
});

test("a failed after-check moves T again once it's empty, and only once (§5.6)", () => {
	const v = view({ tiles: [tile(7, 2, { players: 1 })], moves: [move({ check: failedCheck })] });
	assert.deepEqual(recheckMoves(v), [], "occupied: it waits");
	v.tiles[0].players = 0;
	assert.deepEqual(recheckMoves(v), [{ instanceId: 7, from: 2, reason: "after_check", wasRunning: true }]);
	v.moves.push(move({ id: "7-2", from: 2, to: null, reason: "after_check", step: "failed" }));
	assert.deepEqual(recheckMoves(v), [], "its re-move was tried");
});

test("a failed after-check where only T lagged marks the pair bad but doesn't cap H (S3)", () => {
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
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [{ host: 1, instance: null, rule: "memory" }] },
		"none can go: no_move");
	v.fits = (_id, h) => h === 1;
	assert.deepEqual(overloadMoves(v).beyond, [{ host: 1, instance: null, rule: "memory" }],
		"fitting on its own host doesn't count");
	v.fits = () => true;
	v.draining = [2, 3];
	assert.deepEqual(overloadMoves(v).beyond, [{ host: 1, instance: null, rule: "memory" }],
		"draining hosts aren't open");
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
		tiles: [tile(10, 1), tile(11, 1)], memoryHigh: [1], figure: id => (id === 11 ? 2 * GIB : GIB),
	});
	samples(v, 10, 50, 3); // the only lagging tile: the lag trigger alone would move 10
	samples(v, 11, 60, 4);
	assert.deepEqual(overloadMoves(v).add, [{ instanceId: 11, from: 1, reason: "memory", wasRunning: true }],
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

test("capacity C8: an overload move's passed or skipped check marks its origin; a slow tile marks its target", () => {
	const s = emptyState();
	const judge = (m: Move, check: typeof failedCheck | typeof skipped) => applyCheck(m, check, s, NOW, 1000, 58);
	const passed = { ...failedCheck, ups: 60, ok: true };
	const skipped = { at: NOW, ups: null, ms: null, othersMinUps: null, ok: null };
	judge(move({ reason: "overload" }), passed);
	judge(move({ instanceId: 8, reason: "overload" }), skipped);
	for (const reason of ["manual", "drain", "memory", "after_check"] as const) {
		judge(move({ instanceId: 9, reason }), passed); // not for cause: nothing
	}
	judge(move({ instanceId: 10, reason: "overload" }), failedCheck); // 10 ran at 50 on host 2: it may go back to 1
	judge(move({ instanceId: 11, reason: "overload" }), slowedCheck); // only host 2's other tiles slowed: cap, no mark
	judge(move({ instanceId: 12 }), failedCheck); // the owner's move: 12 ran at 50 on host 2 all the same
	judge(move({ instanceId: 13, reason: "overload", from: null }), passed);
	assert.deepEqual(s.marks, {
		"7:1": { reason: "overload", at: NOW }, "8:1": { reason: "overload", at: NOW },
		"10:2": { reason: "slow", at: NOW }, "12:2": { reason: "slow", at: NOW },
	});
	assert.deepEqual(Object.keys(s.bad), ["10:2", "11:2", "12:2"], "the 24 h bad pair, as before");
	assert.deepEqual(markOf(move({ reason: "overload" }), passed, 58), { host: 1, reason: "overload" });
	assert.equal(markOf(move({ reason: "overload" }), slowedCheck, 58), undefined);
});

test("capacity C8: the owner clears one pair's mark, or all of a host's", () => {
	const at = { reason: "slow" as const, at: NOW };
	const marks = { "7:2": at, "8:2": at, "7:3": at, "2:7": at };
	assert.equal(clearMarks(marks, 2, 7), 1);
	assert.deepEqual(Object.keys(marks), ["8:2", "7:3", "2:7"]);
	assert.equal(clearMarks(marks, 2, 7), 0, "nothing left to clear");
	assert.equal(clearMarks(marks, 7), 1, "all of host 7's");
	assert.equal(clearMarks({ ...marks, "9:3": at }, 3), 2);
	assert.deepEqual(Object.keys(marks), ["8:2", "7:3"]);
});

test("capacity C8: the overload and memory picks skip a tile with nowhere to go; with none the host is beyond", () => {
	const v = view({
		connected: [1, 2], tiles: [tile(10, 1, { players: 1 }), tile(11, 1), tile(12, 1), tile(20, 2)],
		figure: id => id,
	});
	samples(v, 10, 50, 9); // lagging and occupied: its empty neighbours go
	samples(v, 11, 60, 5); // the heaviest empty one
	samples(v, 12, 60, 2);
	const picks = () => overloadMoves(v).add.map(a => a.instanceId);
	assert.deepEqual(picks(), [11]);
	v.marked = (id, h) => id === 11 && h === 2;
	assert.deepEqual(picks(), [12], "11 is marked on the only other host");
	v.memoryHigh = [1];
	assert.deepEqual(overloadMoves(v).add, [{ instanceId: 12, from: 1, reason: "memory", wasRunning: true }],
		"a memory move skips 11 too, for all its larger figure");
	v.memoryHigh = [];
	v.marked = (_id, h) => h === 1;
	assert.deepEqual(picks(), [11], "a mark on the host a tile runs on does nothing");
	v.marked = () => false;
	v.bad = (id, h) => id === 11 && h === 2;
	assert.deepEqual(picks(), [12], "a bad pair");
	v.bad = () => true;
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [{ host: 1, instance: null, rule: "overload" }] },
		"no empty tile has a host to go to: the host is beyond, and no tile is re-picked");
	v.memoryHigh = [1];
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [{ host: 1, instance: null, rule: "memory" }] });
	v.memoryHigh = [];
	v.bad = () => false;
	v.tiles[0].players = 0; // 10 is its host's only lagging tile, and empty
	assert.deepEqual(picks(), [10]);
	v.marked = id => id === 10;
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [{ host: 1, instance: 10, rule: "overload" }] },
		"every other host marked: it stays put");
	v.moves.push(move({ instanceId: 12, reason: "overload", startedAt: NOW - MIN }));
	v.tiles[0].players = 1;
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [] }, "under the 10-minute limit: nothing named yet");
});

test("capacity C8: a drain passes a tile with no host to go to; a mark doesn't stop a drain", () => {
	const v = view({
		connected: [1, 2], draining: [1], tiles: [tile(10, 1), tile(11, 1), tile(12, 1, { status: "stopped" })],
	});
	const picks = () => drainMoves(v).map(a => a.instanceId);
	v.marked = () => true;
	assert.deepEqual(picks(), [10], "marked hosts are a drain's last resort");
	v.bad = id => id === 10;
	assert.deepEqual(picks(), [11], "10's only other host is a bad pair: the drain doesn't stop behind it");
	v.bad = () => false;
	v.fits = () => false;
	assert.deepEqual(picks(), [12], "no room for the running ones; a stopped tile needs none (MR3)");
	v.connected = [1];
	assert.deepEqual(picks(), [], "no other host");
});

/**
 * Capacity amendment C7: tile 10, host 1's only lagging tile, measured best on host 2, where it doesn't fit: reserved
 * 10 minutes ago. Host 2 runs 20 (3 GiB), 21 (5 GiB) and 22 (9 GiB, a player on it); host 3 is empty.
 */
function reserved(over: Partial<View> = {}) {
	const figures: Record<number, number> = { 20: 3, 21: 5, 22: 9 };
	const v = view({
		tiles: [tile(10, 1), tile(11, 1), tile(20, 2), tile(21, 2), tile(22, 2, { players: 1 })],
		moves: [move({
			id: "test", instanceId: 10, to: null, reason: "overload", measure: true, step: "failed",
			error: "needs room on host 2", startedAt: NOW - 11 * MIN, endedAt: NOW - 10 * MIN,
		})],
		fits: (id, h) => !(id === 10 && h === 2),
		figure: id => figures[id],
		reserve: { instanceId: 10, host: 2, until: NOW + 20 * MIN },
		...over,
	});
	samples(v, 10, 50, 12);
	samples(v, 11, 60, 1);
	return v;
}
const room = (instanceId: number) => ({ instanceId, from: 2, reason: "room" as const, wasRunning: true });

test("capacity C7 step 3: until the tile fits, one room move off W: its largest empty tile with a target", () => {
	const v = reserved();
	assert.deepEqual(overloadMoves(v), { add: [room(21)], beyond: [] }, "not 22, which has a player on it");
	v.moves.push(move({ id: "shed", instanceId: 23, from: 2, to: 3, reason: "overload", startedAt: NOW - MIN }));
	assert.deepEqual(overloadMoves(v).add, [room(21)], "exempt from the 10-minute limit");
	assert.deepEqual(decide(v, [], true), { rule: "overload", add: [room(21)], beyond: [] });
	v.moves.push(move({ id: "room", instanceId: 21, from: 2, to: 3, reason: "room", step: "pull", endedAt: null }));
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [] }, "one at a time");
	assert.equal(decide(v, [], true).rule, "overload", "and it holds the overload rule's place");
	v.moves.at(-1)!.step = "done";
	v.moves.at(-1)!.endedAt = NOW;
	v.tiles[3].host = 3;
	assert.deepEqual(overloadMoves(v).add, [room(20)], "21 landed: the next largest");
	v.moves.push(move({ id: "r2", instanceId: 20, from: 2, to: null, reason: "room", step: "failed", endedAt: NOW }));
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [] }, "a room move that just failed isn't asked again");
	const marked = reserved({ marked: (id, h) => id === 21 && h === 3 });
	assert.deepEqual(overloadMoves(marked).add, [room(20)], "21's only target is one it is marked on (C8)");
	const lone = reserved({ tiles: [...reserved().tiles, tile(30, 3), tile(31, 3)] });
	samples(lone, 30, 50, 9);
	samples(lone, 31, 60, 1);
	assert.deepEqual(overloadMoves(lone), { add: [room(21)], beyond: [] }, "no other overload move meanwhile");
	assert.equal(markOf(move({ reason: "room" }), { ...failedCheck, ups: 60, ok: true }, 58), undefined,
		"a room move marks no origin (C8)");
});

test("capacity C7 step 4: once the tile fits, it moves pinned to W; the reservation goes when it has arrived", () => {
	const v = reserved({ fits: () => true });
	const pinned = { instanceId: 10, from: 1, to: 2, reason: "overload" as const, wasRunning: true };
	assert.deepEqual(overloadMoves(v), { add: [pinned], beyond: [] });
	v.moves.push(move({ id: "in", instanceId: 10, reason: "overload", pinned: true, step: "stop", endedAt: null }));
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [] }, "its move is under way: the reservation stands");
	v.moves.at(-1)!.step = "done";
	v.tiles[0].host = 2;
	v.telemetry.forget(10);
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [], release: "clear" }, "arrived: cleared, no bad pair");
});

test("capacity C7 step 5: give up, the pair bad: W closes, the tile leaves, stops lagging or gets a player", () => {
	const gaveUp = { add: [], beyond: [], release: "bad" };
	assert.deepEqual(overloadMoves(reserved({ connected: [1, 3] })), gaveUp, "W is gone");
	assert.deepEqual(overloadMoves(reserved({ draining: [2] })), gaveUp, "W is draining");
	const left = reserved();
	left.tiles[0].host = 3;
	left.telemetry.forget(10); // as the move that took it there did
	assert.deepEqual(overloadMoves(left), gaveUp, "the tile's host changed");
	const fine = reserved();
	samples(fine, 10, 60, 12);
	assert.deepEqual(overloadMoves(fine), gaveUp, "the tile stopped lagging");
	const joined = reserved();
	joined.tiles[0].players = 1;
	assert.deepEqual(overloadMoves(joined), gaveUp, "a player joined the tile");
	assert.deepEqual(overloadMoves(reserved({ reserve: { instanceId: 10, host: 2, until: NOW } })), gaveUp,
		"the 30 minutes passed");
	const failed = reserved({ fits: () => true });
	failed.moves.push(move({
		id: "in", instanceId: 10, reason: "overload", pinned: true, step: "failed", startedAt: NOW - MIN, endedAt: NOW,
	}));
	assert.deepEqual(overloadMoves(failed), gaveUp, "its pinned move ended and it isn't on W: not tried twice");
	assert.deepEqual(decide(reserved({ connected: [1, 3] }), [], true), { rule: "overload", ...gaveUp });
});

test("capacity C7: a failover or a drain that takes the pass clears the reservation, with no bad pair", () => {
	const fo = { instanceId: 99, from: 9, reason: "failover" as const, wasRunning: true };
	const failover = reserved();
	failover.moves.push(move({ id: "f", instanceId: 99, from: 9, reason: "failover", step: "assign", endedAt: null }));
	assert.deepEqual(decide(failover, [], true), { rule: "failover", add: [], beyond: [], release: "clear" });
	const draining = reserved({ draining: [1] });
	draining.moves.push(move({ id: "d", instanceId: 11, reason: "drain", step: "stop", endedAt: null }));
	const drain = decide(draining, [], true);
	assert.deepEqual([drain.rule, drain.release], ["drain", "clear"]);
	assert.equal(decide(reserved({ draining: [3] }), [], true).release, undefined, "a drain with no work: not cleared");
	// A move only asked for this pass may fail at once, and its retry would clear the reservation every 10 minutes.
	assert.deepEqual(decide(reserved(), [fo], true), { rule: "failover", add: [fo], beyond: [] },
		"a failover asked for, none unfinished: not cleared");
	const asked = decide(reserved({ draining: [1] }), [], true);
	assert.deepEqual([asked.rule, asked.add.length, asked.release], ["drain", 1, undefined],
		"a drain asked for, none unfinished: not cleared");
});

test("capacity C7 step 4: the tile isn't sent to W while a room move off W is unfinished, though it fits", () => {
	const v = reserved({ fits: () => true }); // the evicted tile has stopped, so its need is off W
	v.moves.push(move({ id: "room", instanceId: 21, from: 2, to: 3, reason: "room", step: "pull", endedAt: null }));
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [] }, "its move may fail and bring it back to W");
});

test("capacity C7 step 5: a tile that stopped is given up, not started on W", () => {
	const v = reserved({ fits: () => true });
	v.tiles[0].status = "stopped"; // the owner stopped it, or it crashed; its last samples still read as lagging
	assert.deepEqual(overloadMoves(v), { add: [], beyond: [], release: "bad" });
});

test("capacity C7, the two-host limit: nothing is evicted when the only other host is the tile's own", () => {
	assert.deepEqual(overloadMoves(reserved({ connected: [1, 2] })), { add: [], beyond: [] });
});
