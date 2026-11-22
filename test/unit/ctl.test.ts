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
	const until = now + 3_600_000;
	const host = {
		id: 1, name: "dev", connected: true, goneSinceMs: null, cores: 16, cap: null, draining: false, usedPct: 64,
		limitPct: 90, room: 2 ** 30,
	};
	const s: Status = {
		hosts: [host, { ...host, id: 2, name: "vol", cores: null, cap: { tiles: 30, until }, draining: true }],
		tiles: [
			{ id: 7, name: "gridworld_0_0", host: 1, status: "running", ups: 59.96, ms: 1.234, mainMs: 0.987,
				players: 0, copyMtimeMs: now - 180_000, need: 2 ** 30 },
			{ id: 8, name: "t-1", host: null, status: "unassigned", ups: null, ms: null, mainMs: null, players: 2,
				copyMtimeMs: null, need: 2 ** 30 },
		],
		moves: [
			{ ...move, check: { at: 3, ups: 59.9, ms: 3, othersMinUps: 60, ok: true } },
			{ ...move, id: "8-1", instanceId: 8, step: "failed", error: "pre-flight failed on host 2" },
		],
		marks: [
			{ instanceId: 7, hostId: 2, mark: { reason: "overload", at: Date.UTC(2026, 10, 14, 5) } },
			{ instanceId: 9, hostId: 1, mark: { reason: "slow", at: Date.UTC(2026, 10, 2) } },
		],
		reserve: { instanceId: 8, host: 1, until },
	};
	assert.deepEqual(statusText(s, now), [
		"host dev (1) connected 16 cores",
		`host vol (2) connected capped at 30 until ${new Date(until).toTimeString().slice(0, 5)} drained`,
		"gridworld_0_0 (7) host 1 running ups 60.0 ms main 0.99 all 1.23 players 0 copy 3 min old",
		"t-1 (8) host - unassigned ups - ms main - all - players 2 no copy",
		"mark instance 7 host 2 since 2026-11-14: left it under overload",
		"mark instance 9 host 1 since 2026-11-02: ran under the UPS floor there",
		`reserve instance 8 host 1 until ${new Date(until).toTimeString().slice(0, 5)}: making room`,
		"move 7-1 manual instance 7 1 -> 2 done check passed",
		"move 8-1 manual instance 8 1 -> 2 failed (pre-flight failed on host 2)",
	]);
});

test("C13: a move that came back to its source shows as returned", () => {
	const back = { ...move, to: 1, pinned: false, failures: 3, back: true, error: "push failed" };
	const moves = [back, { ...back, step: "failed" as const }];
	assert.deepEqual(statusText({ hosts: [], tiles: [], moves, marks: [], reserve: null }), [
		"move 7-1 manual instance 7 1 -> 1 done returned: push failed",
		"move 7-1 manual instance 7 1 -> 1 failed (push failed)",
	]);
});
