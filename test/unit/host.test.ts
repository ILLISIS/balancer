import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import { HostMemoryEvent } from "../../contracts.js";
import loadHostPlugin from "../../host.js";
import { SAMPLE_MS } from "../../telemetry.js";

test("the host sends its limit and memory at connect, on a change and every 10 s (memory §3.2, MR-C1)", async () => {
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const hooks: Record<string, (...args: any[]) => Promise<void>> = {};
		const hook = (name: string) => ({
			attach: (_plugin: string, fn: (...args: any[]) => Promise<void>) => {
				hooks[name] = fn;
			},
		});
		const config: Record<string, unknown> = {
			"balancer.memory_limit_pct": 90, "balancer.fence_minutes": 12, "host.factorio_directory": "/nonexistent",
		};
		const sent: unknown[] = [];
		const host = {
			hooks: {
				controllerConnectionEvent: hook("connection"), shutdown: hook("shutdown"),
				hostConfigFieldChanged: hook("fieldChanged"),
			},
			config: { get: (field: string) => config[field] },
			send: (event: unknown) => {
				sent.push(event);
			},
			handle: () => undefined,
			instanceConnections: new Map(),
			_shuttingDown: false,
			connected: true,
		};
		const quiet = () => undefined;
		const logger = { log: quiet, error: quiet, warn: quiet, info: quiet, verbose: quiet };
		await loadHostPlugin({ host, logger, plugin: { name: "balancer" } } as any);
		const reports = () => sent.filter((e): e is HostMemoryEvent => e instanceof HostMemoryEvent);
		const limits = () => reports().map(e => e.limitPct);
		await hooks.connection("connect");
		assert.deepEqual(limits(), [90]);
		assert.equal(reports()[0].capacity, os.totalmem(), "the machine's memory, as Clusterio's SystemInfo reads it");
		assert.ok(reports()[0].available > 0 && reports()[0].available <= reports()[0].capacity);
		config["balancer.memory_limit_pct"] = 95;
		await hooks.fieldChanged("balancer.memory_limit_pct", 95, 90);
		await hooks.fieldChanged("balancer.fence_minutes", 10, 12);
		assert.deepEqual(limits(), [90, 95], "only its own field");
		mock.timers.tick(SAMPLE_MS);
		assert.deepEqual(limits(), [90, 95, 95], "every 10 s: a reading older than 60 s gives the host no room");
		host.connected = false;
		mock.timers.tick(SAMPLE_MS);
		assert.equal(reports().length, 3, "nothing while cut off");
		host.connected = true;
		await hooks.connection("connect");
		assert.deepEqual(limits(), [90, 95, 95, 95], "again at the next connect: the controller holds it in memory");
	} finally {
		mock.timers.reset();
	}
});
