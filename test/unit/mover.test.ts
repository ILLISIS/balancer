import { test } from "node:test";
import assert from "node:assert/strict";
import type { Move } from "../../contracts.js";
import { Mover, type MoverConfig, type MoverPort } from "../../mover.js";

const HOUR = 3_600_000;

async function settle() {
	for (let i = 0; i < 20; i++) {
		await new Promise(resolve => {
			setImmediate(resolve);
		});
	}
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(r => {
		resolve = r;
	});
	return { promise, resolve };
}

/**
 * A fake cluster: hosts 1–3 connected; instances 7 and 8 running on host 1, with no players; every game at tick 100.
 * Each call is recorded as text in `calls`, and in `trail` with "saved <step>" for each persist. A call whose text is
 * in `failing` throws, and a pre-flight in `failing` fails. `gates` holds a host's pre-flights until the test opens
 * them.
 */
function fake(config: Partial<MoverConfig> = {}, resumed = true) {
	const calls: string[] = [];
	const trail: string[] = [];
	const phases: string[] = [];
	const finished: string[] = [];
	const failing = new Set<string>();
	const keepRunning = new Set<number>();
	const gates = new Map<number, Promise<void>>();
	const hosts = new Map([[1, true], [2, true], [3, true]]);
	const status = new Map<number, string>([[7, "running"], [8, "running"]]);
	const state = { now: 1_000_000, players: 0, copy: true };
	const moves: Move[] = [];
	const bad: Record<string, number> = {};
	const call = (text: string) => {
		calls.push(text);
		trail.push(text);
		if (failing.has(text)) {
			throw new Error(`${text} failed`);
		}
	};
	const port: MoverPort = {
		now: () => state.now,
		wait: async () => undefined,
		candidates: (_id, from) => [2, 3].filter(h => h !== from && hosts.get(h)),
		hostConnected: h => hosts.get(h) ?? false,
		status: id => status.get(id) ?? "stopped",
		players: () => state.players,
		loadedSave: () => "world.zip",
		hasCopy: () => state.copy,
		preflight: async (id, h) => {
			calls.push(`preflight ${id} ${h}`);
			trail.push(`preflight ${id} ${h}`);
			await gates.get(h);
			return { pass: !failing.has(`preflight ${id} ${h}`), msPerTick: 3, minUps: 60 };
		},
		tick: async id => {
			call(`tick ${id}`);
			return 100;
		},
		stop: async id => {
			if (!keepRunning.has(id)) {
				status.set(id, "stopped");
			}
			call(`stop ${id}`);
		},
		kill: async id => {
			call(`kill ${id}`);
			status.set(id, "stopped");
		},
		pull: async (id, save) => {
			call(`pull ${id} ${save}`);
		},
		assign: async (id, h) => {
			call(`assign ${id} ${h}`);
		},
		push: async id => {
			call(`push ${id}`);
			return "balancer.zip";
		},
		start: async (id, save) => {
			call(`start ${id} ${save}`);
			status.set(id, "running");
		},
		save: async () => {
			trail.push(`saved ${moves.at(-1)?.step}`);
		},
		log: phase => {
			phases.push(phase);
		},
		finished: m => {
			finished.push(m.id);
		},
	};
	const mover = new Mover(moves, bad, port, () => ({
		maxConcurrent: 3, badPairHours: 24, graceMs: 15 * 60_000, ...config,
	}));
	if (resumed) {
		mover.resume(); // nothing starts before the first resume (C47)
	}
	return {
		port, keepRunning, mover, calls, trail, phases, finished, failing, gates, hosts, status, state, moves, bad,
	};
}

const manual = { from: 1, reason: "manual" as const, wasRunning: true };

test("a manual move: pre-flight the best target, then stop, pull, assign, push, start; the tick goes on", async () => {
	const f = fake();
	const m = f.mover.add({ instanceId: 7, ...manual });
	assert.equal(f.mover.moving(7), true);
	await settle();
	assert.deepEqual(f.calls, [
		"preflight 7 2", "tick 7", "stop 7", "pull 7 world.zip", "assign 7 2", "push 7", "start 7 balancer.zip",
		"tick 7",
	]);
	assert.deepEqual(f.phases, [
		"queued", "preflight", "preflight_passed", "stop", "pull", "assign", "push", "start", "done",
	]);
	assert.deepEqual([m.step, m.to, m.save, m.tick, m.endedAt], ["done", 2, "balancer.zip", 100, 1_000_000]);
	assert.equal(f.mover.moving(7), false);
	assert.deepEqual(f.finished, [m.id]);
});

test("every step is written to balancer.json before it runs (§4.3)", async () => {
	const f = fake();
	f.mover.add({ instanceId: 7, ...manual });
	await settle();
	const before = (call: string) => f.trail[f.trail.indexOf(call) - 1];
	assert.equal(before("preflight 7 2"), "saved preflight");
	assert.equal(before("stop 7"), "saved stop");
	assert.equal(before("pull 7 world.zip"), "saved pull");
	assert.equal(before("assign 7 2"), "saved assign");
	assert.equal(before("push 7"), "saved push");
	assert.equal(before("start 7 balancer.zip"), "saved start");
});

test("a failed pre-flight marks the pair bad for 24 h and tries the next target; T keeps running", async () => {
	const f = fake();
	f.failing.add("preflight 7 2");
	const m = f.mover.add({ instanceId: 7, ...manual });
	await settle();
	assert.deepEqual(f.calls.slice(0, 3), ["preflight 7 2", "preflight 7 3", "tick 7"]);
	assert.equal(f.bad["7:2"], 1_000_000 + 24 * HOUR);
	assert.deepEqual([m.step, m.to, m.tried], ["done", 3, [2, 3]]);
	assert.ok(f.phases.includes("preflight_failed"));
});

test("every target failing its pre-flight ends the move failed, with T still running where it was", async () => {
	const f = fake();
	f.failing.add("preflight 7 2").add("preflight 7 3");
	const m = f.mover.add({ instanceId: 7, ...manual });
	await settle();
	assert.deepEqual(f.calls, ["preflight 7 2", "preflight 7 3"]);
	assert.deepEqual([m.step, m.error], ["failed", "every target failed its pre-flight"]);
	assert.equal(f.status.get(7), "running");
	assert.deepEqual(Object.keys(f.bad).sort(), ["7:2", "7:3"]);
	assert.equal(f.mover.moving(7), false);
});

test("a move to a named host tries only that host, even one marked bad (plan ruling 11)", async () => {
	const f = fake();
	f.bad["7:3"] = 2_000_000;
	f.failing.add("preflight 7 3");
	const m = f.mover.add({ instanceId: 7, ...manual, to: 3 });
	await settle();
	assert.deepEqual(f.calls, ["preflight 7 3"]);
	assert.deepEqual([m.step, m.error, m.pinned], ["failed", "pre-flight failed on host 3", true]);
});

test("players on the tile at the stop step: the move ends and T keeps running (B4, Review Focus 1)", async () => {
	const f = fake();
	const gate = deferred();
	f.gates.set(2, gate.promise);
	const m = f.mover.add({ instanceId: 7, ...manual });
	await settle();
	f.state.players = 1; // a player joins during the pre-flight
	gate.resolve();
	await settle();
	assert.deepEqual(f.calls, ["preflight 7 2", "tick 7"]);
	assert.equal(m.step, "failed");
	assert.match(m.error ?? "", /players are on the tile/);
	assert.equal(f.status.get(7), "running");
});

test("a failed pull starts T again on its source (§5.2)", async () => {
	const f = fake();
	f.failing.add("pull 7 world.zip");
	const m = f.mover.add({ instanceId: 7, ...manual });
	await settle();
	assert.deepEqual(f.calls.slice(-3), ["stop 7", "pull 7 world.zip", "start 7 world.zip"]);
	assert.equal(m.step, "failed");
	assert.match(m.error ?? "", /^pull failed/);
	assert.equal(f.status.get(7), "running");
});

test("steps 4–6 fail 3 times from the store, then T goes back to its source with the same copy (§5.2)", async () => {
	const f = fake();
	f.failing.add("assign 7 2");
	const m = f.mover.add({ instanceId: 7, ...manual });
	await settle();
	assert.deepEqual(f.calls.slice(4), [
		"assign 7 2", "assign 7 2", "assign 7 2", "assign 7 1", "push 7", "start 7 balancer.zip", "tick 7",
	]);
	assert.deepEqual([m.step, m.back, m.to, m.error], ["done", true, 1, "assign 7 2 failed"]);
	assert.equal(f.phases.filter(p => p === "retry").length, 3);
});

test("a failover move skips the stop and the pull, and starts only a tile that was running (§5.3)", async () => {
	const f = fake();
	f.hosts.set(1, false);
	f.status.set(7, "unknown");
	f.status.set(8, "unknown");
	const a = f.mover.add({ instanceId: 7, from: 1, reason: "failover", wasRunning: true });
	await settle();
	assert.deepEqual(f.calls, ["preflight 7 2", "assign 7 2", "push 7", "start 7 balancer.zip"]);
	assert.equal(a.step, "done");
	f.calls.length = 0;
	f.mover.add({ instanceId: 8, from: 1, reason: "failover", wasRunning: false });
	await settle();
	assert.deepEqual(f.calls, ["preflight 8 2", "assign 8 2", "push 8"]);
});

test("a controller restart resumes from the persisted step (§5.2, Review Focus 2)", async () => {
	const f = fake();
	f.status.set(7, "stopped");
	f.moves.push({
		id: "7-1", instanceId: 7, from: 1, to: 2, reason: "manual", pinned: false, step: "push", wasRunning: true,
		tried: [2], failures: 0, back: false, save: "world.zip", tick: 100, startedAt: 1, endedAt: null, error: null,
	});
	assert.equal(f.mover.moving(7), true, "moving from the start, before resume()");
	f.mover.resume();
	await settle();
	assert.deepEqual(f.calls, ["push 7", "start 7 balancer.zip", "tick 7"]);
	assert.deepEqual([f.moves[0].step, f.phases[0]], ["done", "resumed"]);
});

test("one move per connected host: a second move from host 1 waits for the first (§4.3)", async () => {
	const f = fake();
	const gate = deferred();
	f.gates.set(2, gate.promise);
	f.mover.add({ instanceId: 7, ...manual });
	const b = f.mover.add({ instanceId: 8, ...manual });
	await settle();
	assert.deepEqual(f.calls, ["preflight 7 2"]);
	assert.equal(b.step, "queued");
	gate.resolve();
	await settle();
	assert.equal(b.step, "done");
	assert.ok(f.calls.includes("preflight 8 2"));
});

test("a gone source doesn't count; each target takes one move at a time (Review Focus 4)", async () => {
	const f = fake();
	f.hosts.set(1, false);
	f.status.set(7, "unknown");
	f.status.set(8, "unknown");
	const gate = deferred();
	f.gates.set(2, gate.promise);
	f.gates.set(3, gate.promise);
	f.mover.add({ instanceId: 7, from: 1, reason: "failover", wasRunning: true });
	f.mover.add({ instanceId: 8, from: 1, reason: "failover", wasRunning: true });
	await settle();
	assert.deepEqual(f.calls, ["preflight 7 2", "preflight 8 3"], "both at once, on different targets");
	gate.resolve();
	await settle();
	assert.deepEqual(f.moves.map(m => [m.step, m.to]), [["done", 2], ["done", 3]]);
});

test("max_concurrent_moves caps the cluster (§4.3)", async () => {
	const f = fake({ maxConcurrent: 1 });
	f.hosts.set(1, false);
	f.status.set(7, "unknown");
	f.status.set(8, "unknown");
	const gate = deferred();
	f.gates.set(2, gate.promise);
	f.mover.add({ instanceId: 7, from: 1, reason: "failover", wasRunning: true });
	f.mover.add({ instanceId: 8, from: 1, reason: "failover", wasRunning: true });
	await settle();
	assert.deepEqual(f.calls, ["preflight 7 2"]);
	gate.resolve();
	await settle();
	assert.deepEqual(f.moves.map(m => m.step), ["done", "done"]);
});

test("no stored copy: the move fails at once (plan ruling 6)", async () => {
	const f = fake();
	f.state.copy = false;
	const m = f.mover.add({ instanceId: 7, ...manual });
	await settle();
	assert.deepEqual([f.calls, m.step], [[], "failed"]);
});

test("a stop that throws after the tile stopped starts it again on its source (C8)", async () => {
	const f = fake();
	f.failing.add("stop 7");
	const m = f.mover.add({ instanceId: 7, ...manual });
	await settle();
	assert.deepEqual(f.calls.slice(-2), ["stop 7", "start 7 world.zip"]);
	assert.deepEqual([m.step, m.error], ["failed", "stop failed: stop 7 failed"]);
	assert.equal(f.status.get(7), "running");
});

test("retries exhausted with the status unknown: no second copy on the source; the move fails (C21)", async () => {
	const f = fake();
	f.port.assign = async (id, h) => {
		f.calls.push(`assign ${id} ${h}`);
		f.status.set(id, "unknown");
		throw new Error("connection lost");
	};
	const m = f.mover.add({ instanceId: 7, ...manual });
	await settle();
	assert.deepEqual(f.calls.filter(c => c.startsWith("assign") || c.startsWith("start")), [
		"assign 7 2", "assign 7 2", "assign 7 2",
	]);
	assert.deepEqual([m.step, m.back, m.to, m.error], ["failed", false, 2, "connection lost"]);
});

test("a start that loads an older tick kills T, and the retry starts it again (C23)", async () => {
	const f = fake();
	let reads = 0;
	f.port.tick = async id => {
		f.calls.push(`tick ${id}`);
		reads += 1;
		return reads === 2 ? 50 : 100;
	};
	const m = f.mover.add({ instanceId: 7, ...manual });
	await settle();
	assert.deepEqual(f.calls.slice(-8), [
		"push 7", "start 7 balancer.zip", "tick 7", "kill 7", "assign 7 2", "push 7", "start 7 balancer.zip", "tick 7",
	]);
	assert.deepEqual([m.step, m.failures], ["done", 1]);
});

test("a restart resumed at the start step with T already running only reads the tick (C25)", async () => {
	const f = fake();
	f.moves.push({
		id: "7-1", instanceId: 7, from: 1, to: 2, reason: "manual", pinned: false, step: "start", wasRunning: true,
		tried: [2], failures: 0, back: false, save: "balancer.zip", tick: 100, startedAt: 1, endedAt: null, error: null,
	});
	f.mover.resume();
	await settle();
	assert.deepEqual(f.calls, ["tick 7"]);
	assert.equal(f.moves[0].step, "done");
});

test("a stop that throws while T still runs ends the move failed with no restart (C25)", async () => {
	const f = fake();
	f.keepRunning.add(7);
	f.failing.add("stop 7");
	const m = f.mover.add({ instanceId: 7, ...manual });
	await settle();
	assert.deepEqual(f.calls.slice(-2), ["tick 7", "stop 7"]);
	assert.deepEqual([m.step, f.status.get(7)], ["failed", "running"]);
});

const assignMove = (): Move => ({
	id: "7-1", instanceId: 7, from: 1, to: 2, reason: "manual", pinned: false, step: "assign", wasRunning: true,
	tried: [2], failures: 0, back: false, save: "world.zip", tick: 100, startedAt: 1, endedAt: null, error: null,
});

test("a resumed move waits for the host its step talks to, and runs once it connects (C43)", async () => {
	const f = fake();
	f.status.set(7, "stopped");
	f.hosts.set(2, false);
	f.moves.push(assignMove());
	f.mover.resume();
	await settle();
	assert.deepEqual([f.calls, f.moves[0].step, f.mover.moving(7)], [[], "assign", true]);
	f.hosts.set(2, true);
	f.mover.pump();
	f.mover.pump();
	await settle();
	assert.deepEqual(f.calls, ["assign 7 2", "push 7", "start 7 balancer.zip", "tick 7"]);
	assert.equal(f.moves[0].step, "done");
});

test("a stop or pull step waits for the source host instead (C43)", async () => {
	const f = fake();
	f.hosts.set(1, false);
	f.moves.push({ ...assignMove(), step: "pull" });
	f.mover.resume();
	await settle();
	assert.deepEqual(f.calls, []);
	f.hosts.set(1, true);
	f.mover.pump();
	await settle();
	assert.equal(f.calls[0], "pull 7 world.zip");
});

test("a stop step also waits until its tile's status is known (C43)", async () => {
	const f = fake();
	f.status.set(7, "unknown");
	f.moves.push({ ...assignMove(), step: "stop" });
	f.mover.resume();
	await settle();
	f.mover.pump();
	await settle();
	assert.deepEqual(f.calls, []);
	f.status.set(7, "stopped");
	f.mover.pump();
	await settle();
	assert.equal(f.calls[0], "pull 7 world.zip");
});

test("after the grace a waiting move runs anyway, into its usual failure path (C43)", async () => {
	const f = fake();
	f.hosts.set(2, false);
	f.status.set(7, "unknown");
	f.port.assign = async () => {
		throw new Error("Host is not connected");
	};
	f.moves.push(assignMove());
	f.mover.resume();
	await settle();
	assert.equal(f.moves[0].step, "assign");
	f.state.now += 15 * 60_000;
	f.mover.pump();
	await settle();
	assert.deepEqual([f.moves[0].step, f.moves[0].error], ["failed", "Host is not connected"]);
});

test("nothing starts before the first resume (C47)", async () => {
	const f = fake({}, false);
	const m = f.mover.add({ instanceId: 7, ...manual });
	await settle();
	assert.deepEqual([f.calls, m.step], [[], "queued"]);
	f.mover.resume();
	await settle();
	assert.equal(m.step, "done");
});

test("a pre-flight that throws leaves the pair usable; only a verdict marks it bad (C46)", async () => {
	const f = fake();
	f.port.preflight = async (id, h) => {
		f.calls.push(`preflight ${id} ${h}`);
		if (h === 2) {
			throw new Error("stream timeout");
		}
		return { pass: false, msPerTick: 9, minUps: 40 };
	};
	f.mover.add({ instanceId: 7, ...manual });
	await settle();
	assert.deepEqual(Object.keys(f.bad), ["7:3"], "host 3 failed its pre-flight; host 2 only errored");
});
