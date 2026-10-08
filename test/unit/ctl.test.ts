import { test } from "node:test";
import assert from "node:assert/strict";
import type { Status } from "../../contracts.js";
import { statusText } from "../../ctl.js";

test("balancer status prints a line per instance, then one per move", () => {
	const now = 1_000_000;
	const s: Status = {
		hosts: [{ id: 1, name: "dev", connected: true, goneSinceMs: null }],
		tiles: [
			{ id: 7, name: "gridworld_0_0", host: 1, status: "running", ups: 59.96, ms: 1.234, players: 0,
				copyMtimeMs: now - 180_000 },
			{ id: 8, name: "t-1", host: null, status: "unassigned", ups: null, ms: null, players: 2,
				copyMtimeMs: null },
		],
		moves: [{
			id: "7-1", instanceId: 7, from: 1, to: 2, reason: "manual", pinned: true, step: "failed", wasRunning: true,
			tried: [2], failures: 0, back: false, save: null, tick: null, startedAt: 1, endedAt: 2,
			error: "pre-flight failed on host 2",
		}],
	};
	assert.deepEqual(statusText(s, now), [
		"gridworld_0_0 (7) host 1 running ups 60.0 ms 1.23 players 0 copy 3 min old",
		"t-1 (8) host - unassigned ups - ms - players 2 no copy",
		"move 7-1 manual instance 7 1 -> 2 failed (pre-flight failed on host 2)",
	]);
});

test("C13: a move that came back to its source shows as returned", () => {
	const move = {
		id: "7-1", instanceId: 7, from: 1, to: 1, reason: "manual" as const, pinned: false, step: "done" as const,
		wasRunning: true, tried: [2], failures: 3, back: true, save: null, tick: null, startedAt: 1, endedAt: 2,
		error: "push failed",
	};
	assert.deepEqual(statusText({ hosts: [], tiles: [], moves: [move, { ...move, step: "failed" }] }), [
		"move 7-1 manual instance 7 1 -> 1 done returned: push failed",
		"move 7-1 manual instance 7 1 -> 1 failed (push failed)",
	]);
});
