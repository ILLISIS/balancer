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
	await Promise.all([first, save()]);
	const again = await openState(dir);
	assert.deepEqual(again.state, {
		copies: {}, moves: [], bad: { "7:2": 1000 }, wasRunning: [7], hosts: {}, draining: [2], reference: null,
	});
	assert.equal(JSON.parse(await readFile(join(dir, STATE_FILE), "utf8")).schema, 2);
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
		...v1, moves: [{ ...move, preflight: null, check: null }], hosts: {}, draining: [], reference: null,
	});
});
