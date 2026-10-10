import { test } from "node:test";
import assert from "node:assert/strict";
import type { Status } from "../../contracts.js";
import { statusText } from "../../ctl.js";

const move = {
	id: "7-1", instanceId: 7, from: 1, to: 2, reason: "manual" as const, pinned: true, step: "done" as const,
	wasRunning: true, tried: [2], failures: 0, back: false, save: null, tick: null, startedAt: 1, endedAt: 2,
	error: null, preflight: null, check: null,
};

test("balancer status prints a line per host, per instance, then per move", () => {
	const now = 1_000_000;
	const host = {
		id: 1, name: "dev", connected: true, goneSinceMs: null, speed: 0.438, slots: 3, learned: true, busy: 2,
		draining: false, benchmarking: false, usedPct: 64, limitPct: 90, room: 2 ** 30,
	};
	const s: Status = {
		hosts: [host, {
			...host, id: 2, name: "vol", speed: null, slots: null, learned: false, busy: 0, draining: true,
			benchmarking: true,
		}],
		tiles: [
			{ id: 7, name: "gridworld_0_0", host: 1, status: "running", ups: 59.96, ms: 1.234, players: 0,
				copyMtimeMs: now - 180_000, need: 2 ** 30 },
			{ id: 8, name: "t-1", host: null, status: "unassigned", ups: null, ms: null, players: 2,
				copyMtimeMs: null, need: 2 ** 30 },
		],
		moves: [
			{ ...move, check: { at: 3, ups: 59.9, ms: 3, othersMinUps: 60, ok: true } },
			{ ...move, id: "8-1", instanceId: 8, step: "failed", error: "pre-flight failed on host 2" },
		],
	};
	assert.deepEqual(statusText(s, now), [
		"host dev (1) connected speed 0.44 ms slots 3 (learned) busy 2",
		"host vol (2) connected unbenchmarked busy 0 drained benchmarking",
		"gridworld_0_0 (7) host 1 running ups 60.0 ms 1.23 players 0 copy 3 min old",
		"t-1 (8) host - unassigned ups - ms - players 2 no copy",
		"move 7-1 manual instance 7 1 -> 2 done check passed",
		"move 8-1 manual instance 8 1 -> 2 failed (pre-flight failed on host 2)",
	]);
});

test("C13: a move that came back to its source shows as returned", () => {
	const back = { ...move, to: 1, pinned: false, failures: 3, back: true, error: "push failed" };
	assert.deepEqual(statusText({ hosts: [], tiles: [], moves: [back, { ...back, step: "failed" }] }), [
		"move 7-1 manual instance 7 1 -> 1 done returned: push failed",
		"move 7-1 manual instance 7 1 -> 1 failed (push failed)",
	]);
});
