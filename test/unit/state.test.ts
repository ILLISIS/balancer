import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_FILE, emptyState, openState } from "../../state.js";

test("openState starts empty; save() writes balancer.json as the state is at each call, in order", async () => {
	const dir = await mkdtemp(join(tmpdir(), "balancer-state-"));
	const { state, save } = await openState(dir);
	assert.deepEqual(state, emptyState());
	state.wasRunning.push(7);
	const first = save();
	state.bad["7:2"] = 1000;
	state.draining.push(2);
	state.memory[7] = 2 ** 30;
	state.marks["7:2"] = { reason: "slow", at: 5 };
	await Promise.all([first, save()]);
	const again = await openState(dir);
	assert.deepEqual(again.state, {
		copies: {}, moves: [], bad: { "7:2": 1000 }, wasRunning: [7], hosts: {}, draining: [2], memory: { 7: 2 ** 30 },
		marks: { "7:2": { reason: "slow", at: 5 } },
	}, "memory amendment §3.1, capacity C8: the figures and the marks survive a restart");
	assert.equal(JSON.parse(await readFile(join(dir, STATE_FILE), "utf8")).schema, 3);
});

test("schema 1 gains phase 2's fields; its moves an empty pre-flight and check (R2)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "balancer-state-"));
	const move = {
		id: "7-1", instanceId: 7, from: 1, to: 2, reason: "manual", pinned: false, step: "done", wasRunning: true,
		tried: [2], failures: 0, back: false, save: "balancer.zip", tick: 100, startedAt: 1, endedAt: 2, error: null,
	};
	const v1 = { copies: {}, moves: [move], bad: {}, wasRunning: [3] };
	await writeFile(join(dir, STATE_FILE), JSON.stringify({ schema: 1, data: v1 }));
	const { state } = await openState(dir);
	assert.deepEqual(state, {
		...v1, moves: [{ ...move, preflight: null, check: null }], hosts: {}, draining: [], reference: null, memory: {},
		marks: {},
	});
});

test("schema 2 gains the tiles' memory figures, empty (memory amendment §3.1)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "balancer-state-"));
	const v2 = { copies: {}, moves: [], bad: {}, wasRunning: [], hosts: {}, draining: [2], reference: null };
	await writeFile(join(dir, STATE_FILE), JSON.stringify({ schema: 2, data: v2 }));
	const { state } = await openState(dir);
	assert.deepEqual(state, { ...v2, memory: {}, marks: {} });
});

test("capacity C8: a deployed balancer.json without marks reads as none, with no migration", async () => {
	const dir = await mkdtemp(join(tmpdir(), "balancer-state-"));
	const v3 = { copies: {}, moves: [], bad: {}, wasRunning: [], hosts: {}, draining: [], memory: {} };
	await writeFile(join(dir, STATE_FILE), JSON.stringify({ schema: 3, data: v3 }));
	const { state, save } = await openState(dir);
	assert.deepEqual(state.marks, {});
	assert.equal(state.reserve, undefined, "C7: nor a reservation");
	state.reserve = { instanceId: 7, host: 2, until: 5 };
	await save();
	assert.deepEqual((await openState(dir)).state.reserve, { instanceId: 7, host: 2, until: 5 });
	assert.equal(JSON.parse(await readFile(join(dir, STATE_FILE), "utf8")).schema, 3);
});
