import { test } from "node:test";
import assert from "node:assert/strict";
import { Telemetry, cpuMs, sample } from "../../telemetry.js";

test("a sample's UPS is the ticks over the time, its ms the CPU time over the ticks (§4.1)", () => {
	const s = sample({ tick: 1000, cpuMs: 5000, at: 0 }, { tick: 1600, cpuMs: 6200, at: 10_000 });
	assert.deepEqual(s, { at: 10_000, ups: 60, ms: 2 });
	assert.equal(sample({ tick: 1000, cpuMs: null, at: 0 }, { tick: 1300, cpuMs: 9, at: 10_000 })?.ms, null);
	assert.equal(sample({ tick: 1000, cpuMs: 1, at: 0 }, { tick: 900, cpuMs: 2, at: 10_000 }), undefined, "a restart");
	assert.equal(sample({ tick: 1000, cpuMs: 1, at: 0 }, { tick: 1000, cpuMs: 2, at: 10_000 }), undefined, "paused");
});

test("cpuMs reads this process's CPU time from /proc, and null for a process that doesn't exist", async () => {
	const ms = await cpuMs(process.pid);
	assert.ok(ms !== null && ms > 0, `got ${ms}`);
	assert.equal(await cpuMs(2 ** 30), null);
});

test("the controller keeps 5 minutes: the last sample, the lowest UPS in a window, the last minute's mean ms", () => {
	let now = 1_000_000;
	const t = new Telemetry(() => now);
	t.add(7, [{ at: now - 400_000, ups: 10, ms: 9 }, { at: now - 50_000, ups: 59, ms: 2 }]);
	t.add(7, [{ at: now - 20_000, ups: 57.5, ms: null }, { at: now, ups: 60, ms: 4 }]);
	assert.deepEqual(t.last(7), { at: now, ups: 60, ms: 4 });
	assert.equal(t.minUps(7, now - 60_000, now), 57.5);
	assert.equal(t.minUps(7, now - 20_000, now), 60, "a window is (from, to]");
	assert.equal(t.minUps(7, now, now + 1), undefined);
	assert.equal(t.meanMs(7), 3, "(2 + 4) / 2: the 400 s old sample is gone, the null one doesn't count");
	assert.equal(t.last(8), undefined);
	now += 301_000;
	assert.equal(t.last(7), undefined, "older than 5 minutes");
});

test("received samples are moved into the controller's clock, keeping their spacing (C2)", () => {
	const now = 1_000_000;
	const t = new Telemetry(() => now);
	// A host whose clock is 60 s ahead.
	t.receive(7, [{ at: now + 60_000 - 30_000, ups: 55, ms: 1 }, { at: now + 60_000, ups: 60, ms: 3 }]);
	assert.deepEqual(t.last(7), { at: now, ups: 60, ms: 3 });
	assert.equal(t.minUps(7, now - 60_000, now), 55);
	assert.equal(t.minUps(7, now - 30_000, now), 60, "the older one stays 30 s back");
	assert.equal(t.meanMs(7), 2);
	t.receive(8, []);
	assert.equal(t.last(8), undefined);
});

test("meanMs windows on the instance's newest sample, so a late report still has its minute (C15)", () => {
	let now = 1_000_000;
	const t = new Telemetry(() => now);
	t.add(7, [1, 2, 3, 4, 5, 6].map(i => ({ at: now - (6 - i) * 10_000, ups: 60, ms: i })));
	now += 70_000;
	assert.equal(t.meanMs(7), 3.5);
});
