import { test } from "node:test";
import assert from "node:assert/strict";
import { KEEP_MS, SaveStalls, Telemetry, cpuMs, memBytes, memFigure, sample } from "../../telemetry.js";

test("a sample's UPS is the ticks over the time, its ms the CPU time over the ticks (§4.1)", () => {
	const s = sample({ tick: 1000, cpuMs: 5000, at: 0 }, { tick: 1600, cpuMs: 6200, at: 10_000 });
	assert.deepEqual(s, { at: 10_000, ups: 60, ms: 2, mem: null });
	const withMem = sample({ tick: 1000, cpuMs: 1, at: 0, mem: 5 }, { tick: 1600, cpuMs: 2, at: 10_000, mem: 7 });
	assert.equal(withMem?.mem, 7, "memory amendment §3.1: the newer reading's figure");
	assert.equal(sample({ tick: 1000, cpuMs: null, at: 0 }, { tick: 1300, cpuMs: 9, at: 10_000 })?.ms, null);
	assert.equal(sample({ tick: 1000, cpuMs: 1, at: 0 }, { tick: 900, cpuMs: 2, at: 10_000 }), undefined, "a restart");
	assert.equal(sample({ tick: 1000, cpuMs: 1, at: 0 }, { tick: 1000, cpuMs: 2, at: 10_000 }), undefined, "paused");
});

test("cpuMs reads this process's CPU time from /proc, and null for a process that doesn't exist", async () => {
	const ms = await cpuMs(process.pid);
	assert.ok(ms !== null && ms > 0, `got ${ms}`);
	assert.equal(await cpuMs(2 ** 30), null);
});

test("memory §3.1: a process's figure is max(VmHWM, VmRSS + VmSwap) in bytes; null with no /proc entry", async () => {
	const status = (hwm: number, rss: number, swap?: number) => [
		"Name:\tfactorio", `VmHWM:\t${String(hwm).padStart(8)} kB`, `VmRSS:\t${String(rss).padStart(8)} kB`,
		...(swap === undefined ? [] : [`VmSwap:\t${String(swap).padStart(8)} kB`]), "Threads:\t12",
	].join("\n");
	assert.equal(memFigure(status(719_000, 24_000, 342_000)), 719_000 * 1024, "the peak");
	assert.equal(memFigure(status(719_000, 407_000, 401_000)), 808_000 * 1024, "resident and swapped beat the peak");
	assert.equal(memFigure(status(100, 300)), 300 * 1024, "no VmSwap line");
	assert.equal(memFigure("Name:\tkthreadd\nThreads:\t1\n"), null, "a kernel thread names none");
	const own = await memBytes(process.pid);
	assert.ok(own !== null && own > 0, `got ${own}`);
	assert.equal(await memBytes(2 ** 30), null);
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

test("P1 (spike 33a): a blocking autosave's stall is left out of the sample's elapsed time (Review Focus 1)", () => {
	const s = sample({ tick: 1000, cpuMs: 0, at: 0 }, { tick: 1552, cpuMs: 0, at: 10_000 }, 800);
	assert.equal(s?.ups, 60, "552 ticks in 9.2 s of running");
	const stalls = new SaveStalls();
	stalls.line("Saving to _autosave3 (blocking).", 1_000);
	stalls.line("Saving finished", 1_833);
	stalls.line("Saving finished", 5_000); // a /server-save's end: no autosave started
	stalls.line("Saving to _autosave4 (non-blocking).", 6_000);
	stalls.line("Saving finished", 6_500);
	assert.equal(stalls.take(), 833);
	assert.equal(stalls.take(), 0, "take() starts over");
});

test("lagging (§5.5, R14): every sample of the last lag_minutes under the floor, enough of them to cover it", () => {
	const now = 1_000_000;
	const t = new Telemetry(() => now);
	const run = (ups: (i: number) => number, n: number) => Array.from({ length: n }, (_, i) => (
		{ at: now - (n - 1 - i) * 10_000, ups: ups(i), ms: 1 }
	));
	t.add(1, run(() => 50, 18)); // 3 minutes under
	t.add(2, run(i => (i === 0 ? 58 : 50), 18)); // one sample at the floor
	t.add(3, run(() => 50, 12)); // only 2 minutes held
	t.add(4, run(i => (i < 6 ? 60 : 50), 24)); // 4 minutes held, the last 3 under
	assert.deepEqual([1, 2, 3, 4].map(id => t.lagging(id, 58, 180_000)), [true, false, false, true]);
	assert.equal(t.lagging(5, 58, 180_000), false, "no samples");
});

test("lagging (M1): a window longer than the retention behaves as the clamped one", () => {
	const now = 1_000_000;
	const t = new Telemetry(() => now);
	t.add(1, Array.from({ length: 30 }, (_, i) => ({ at: now - (29 - i) * 10_000, ups: 50, ms: 1 })));
	assert.equal(t.lagging(1, 58, 240_000), true);
	assert.equal(t.lagging(1, 58, KEEP_MS * 2), true, "clamped, not never");
});

test("mean (§5.6): the mean UPS and CPU ms per tick of the samples that ended in (from, to]", () => {
	const now = 1_000_000;
	const t = new Telemetry(() => now);
	t.add(7, [
		{ at: now - 30_000, ups: 50, ms: 9 }, { at: now - 20_000, ups: 59, ms: 2 }, { at: now, ups: 61, ms: null },
	]);
	assert.deepEqual(t.mean(7, now - 25_000, now), { ups: 60, ms: 2 });
	assert.equal(t.mean(7, now, now + 1), undefined);
	assert.equal(t.mean(8, 0, now), undefined);
});

test("forget (S2): drops that instance's samples only", () => {
	const now = 1_000_000;
	const t = new Telemetry(() => now);
	t.add(1, [{ at: now, ups: 60, ms: 1 }]);
	t.add(2, [{ at: now, ups: 60, ms: 1 }]);
	t.forget(1);
	assert.equal(t.last(1), undefined);
	assert.equal(t.last(2)?.ups, 60);
});
