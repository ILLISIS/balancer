import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as lib from "@clusterio/lib";
import { balancerApi, setBalancerApi } from "../../api.js";
import { MoveRequest, PreflightRequest, TelemetryEvent } from "../../contracts.js";
import { plugin } from "../../index.js";

// Compiled to dist/node/test/unit/; the plugin root is four levels up.
const pluginRoot = join(import.meta.dirname, "..", "..", "..", "..");

test("the declaration names the plugin; each compiled entrypoint exists and exports a default function", async () => {
	assert.equal(plugin.name, "balancer");
	const entries = [
		plugin.controllerEntrypoint, plugin.hostEntrypoint, plugin.instanceEntrypoint, plugin.ctlEntrypoint,
	];
	for (const entry of entries) {
		assert.ok(entry, "entrypoint declared");
		await access(join(pluginRoot, entry));
		const loaded = await import(pathToFileURL(join(pluginRoot, entry)).href);
		assert.equal(typeof loaded.default, "function", entry);
	}
});

test("it registers its 4 messages and 2 permissions, and §6's defaults", () => {
	lib.registerPluginMessages([plugin] as unknown as lib.PluginNodeEnvInfo[]);
	lib.registerPluginPermissions([plugin] as unknown as lib.PluginNodeEnvInfo[]);
	assert.ok(lib.Link._eventsByName.has("balancer:TelemetryEvent"));
	for (const name of ["PreflightRequest", "MoveRequest", "StatusRequest"]) {
		assert.ok(lib.Link._requestsByName.has(`balancer:${name}`), name);
	}
	assert.equal(plugin.messages?.length, 4);
	assert.ok(lib.permissions.has("balancer.view") && lib.permissions.has("balancer.move"));
	const defaults = Object.fromEntries(
		Object.entries(plugin.controllerConfigFields ?? {}).map(([field, def]) => [field, def.initialValue]),
	);
	assert.deepEqual(defaults, {
		"balancer.enabled": true,
		"balancer.failover_grace_minutes": 15,
		"balancer.ups_floor": 58,
		"balancer.busy_tile_ms": 2,
		"balancer.preflight_max_ms": 10,
		"balancer.max_concurrent_moves": 3,
		"balancer.bad_pair_hours": 24,
	});
	assert.equal(plugin.hostConfigFields?.["balancer.fence_minutes"]?.initialValue, 12);
});

test("every message survives the JSON its link carries", () => {
	const roundTrip = (Class: { jsonSchema: object; fromJSON(json: any): unknown }, message: object) => {
		const json = JSON.parse(JSON.stringify(message));
		assert.equal(lib.compile(Class.jsonSchema as any)(json), true, message.constructor.name);
		return Class.fromJSON(json);
	};
	const samples = [{ at: 1000, ups: 59.5, ms: 2.25 }, { at: 11000, ups: 60, ms: null }];
	assert.deepEqual(roundTrip(TelemetryEvent, new TelemetryEvent(samples)), new TelemetryEvent(samples));
	assert.deepEqual(roundTrip(MoveRequest, new MoveRequest(7)), new MoveRequest(7));
	assert.deepEqual(roundTrip(MoveRequest, new MoveRequest(7, 2)), new MoveRequest(7, 2));
	const pack = new lib.ModPack();
	pack.name = "v2-dev";
	const back = roundTrip(PreflightRequest, new PreflightRequest(7, "ab12", pack, "2.1.21", 1800)) as PreflightRequest;
	assert.ok(back.modPack instanceof lib.ModPack);
	assert.deepEqual(
		[back.instanceId, back.streamId, back.modPack.name, back.factorioVersion, back.ticks],
		[7, "ab12", "v2-dev", "2.1.21", 1800],
	);
});

test("balancerApi() throws until the controller plugin sets it: the edgeApi pattern (§4.5)", () => {
	setBalancerApi(undefined);
	assert.throws(() => balancerApi(), /the API is not ready/);
	const api = { moving: () => true, onMoveFinished: () => () => undefined };
	setBalancerApi(api);
	assert.equal(balancerApi(), api);
	setBalancerApi(undefined);
});
