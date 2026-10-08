import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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
	await Promise.all([first, save()]);
	const again = await openState(dir);
	assert.deepEqual(again.state, { copies: {}, moves: [], bad: { "7:2": 1000 }, wasRunning: [7] });
	assert.equal(JSON.parse(await readFile(join(dir, STATE_FILE), "utf8")).schema, 1);
});
