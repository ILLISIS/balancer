import { test } from "node:test";
import assert from "node:assert/strict";
import { Fence, fenceEvent, stopLive } from "../../fence.js";

test("a drop arms the fence; it fires after the minutes unless a connect or resume comes first (§7)", t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let fired = 0;
	let minutes = 12;
	const fence = new Fence(() => minutes, () => {
		fired += 1;
	});
	fence.event("drop");
	assert.equal(fence.armed, true);
	t.mock.timers.tick(12 * 60_000 - 1);
	fence.event("resume");
	t.mock.timers.tick(60_000);
	assert.equal(fired, 0, "the link came back in time");
	fence.event("drop");
	t.mock.timers.tick(6 * 60_000);
	fence.event("drop"); // a second drop keeps the first one's clock
	t.mock.timers.tick(6 * 60_000);
	assert.equal(fired, 1);
	assert.equal(fence.armed, false);
	fence.event("connect");
	minutes = 2;
	fence.event("drop");
	fence.event("close"); // the host shutting down: no change
	t.mock.timers.tick(2 * 60_000);
	assert.equal(fired, 2, "the minutes are read at each drop");
});

test("connect disarms the fence; a graceful close arms it only through the host's mapping to drop (§7)", t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let fired = 0;
	const fence = new Fence(() => 12, () => {
		fired += 1;
	});
	fence.event("drop");
	t.mock.timers.tick(11 * 60_000);
	fence.event("connect");
	t.mock.timers.tick(2 * 60_000);
	assert.equal(fired, 0);
	assert.equal(fence.armed, false);
	fence.event("close"); // the fence itself ignores close; host.ts maps it to drop unless the host is shutting down
	assert.equal(fence.armed, false);
});

test("a close arms the fence unless the host itself is shutting down; other events pass through", t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let fired = 0;
	const fence = new Fence(() => 12, () => {
		fired += 1;
	});
	fence.event(fenceEvent("close", true));
	assert.equal(fence.armed, false);
	t.mock.timers.tick(13 * 60_000);
	assert.equal(fired, 0);
	fence.event(fenceEvent("close", false));
	assert.equal(fence.armed, true);
	t.mock.timers.tick(12 * 60_000);
	assert.equal(fired, 1);
	for (const e of ["connect", "drop", "resume"] as const) {
		assert.equal(fenceEvent(e, false), e);
		assert.equal(fenceEvent(e, true), e);
	}
});

test("a tile whose stop rejects is killed, and a failed kill is logged (C50)", async () => {
	const lines: string[] = [];
	const ok = { id: 1, stop: async () => undefined, kill: async () => assert.fail("killed a stopped tile") };
	const bad = { id: 2, stop: async () => { throw new Error("hook"); }, kill: async () => undefined };
	const worse = {
		id: 3, stop: async () => { throw new Error("hook"); }, kill: async () => { throw new Error("gone"); },
	};
	stopLive([ok, bad, worse], (phase, fields) => lines.push(`${phase} ${fields.instance}`));
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(lines.sort(), ["kill_failed 3", "killed 2", "stop_failed 2", "stop_failed 3", "stopped 1"]);
});
