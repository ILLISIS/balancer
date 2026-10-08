import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as lib from "@clusterio/lib";
import type { HostPluginContext } from "@clusterio/host";
import { lifecycle } from "universal_edges/runtime";
import { HostLeavingEvent, PreflightRequest } from "./contracts.js";
import { Fence, fenceEvent } from "./fence.js";
import { local } from "./local.js";
import { benchmark, factorioInstall, modsDir } from "./preflight.js";
import { SAMPLE_MS } from "./telemetry.js";

/** The host plugin (§4.2): the fence (§7) and the pre-flight (§5.2 step 1). */
export default async function loadHostPlugin(context: HostPluginContext) {
	const { host, logger, plugin } = context;

	// §7, B10: cut off for balancer.fence_minutes, this host saves and stops its own tiles.
	const fence = new Fence(() => host.config.get("balancer.fence_minutes"), () => {
		const live = [...host.instanceConnections.values()].map(c => c.instance)
			.filter(i => i.status === "starting" || i.status === "running");
		lifecycle(logger, "balancer.fence", "fired", { instances: live.map(i => i.id) }, "warn");
		for (const i of live) {
			i.stop().then(
				() => lifecycle(logger, "balancer.fence", "stopped", { instance: i.id }, "warn"),
				(err: Error) => {
					const fields = { instance: i.id, error: err.message };
					lifecycle(logger, "balancer.fence", "stop_failed", fields, "error");
				},
			);
		}
	});
	host.hooks.controllerConnectionEvent.attach(plugin.name, async event => {
		fence.event(fenceEvent(event, host._shuttingDown));
	});

	// §5.3: a clean shutdown stops the instances before it disconnects; say which were running first (C34).
	host.hooks.shutdown.attach(plugin.name, async () => {
		const running = [...host.instanceConnections.values()].map(c => c.instance)
			.filter(i => i.status === "starting" || i.status === "running").map(i => i.id);
		if (running.length > 0) {
			host.send(new HostLeavingEvent(running));
		}
	});

	// §5.2 step 1: benchmark the controller's copy of a tile here, next to this host's running tiles.
	host.handle(PreflightRequest, async (request: PreflightRequest) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "balancer-preflight-"));
		local.preflights += 1; // this host's instances report every sample until it ends (§4.1)
		const started = Date.now();
		try {
			const url = new URL(host.config.get("host.controller_url"));
			url.pathname += `api/stream/${request.streamId}`;
			const save = path.join(dir, "save.zip");
			await lib.downloadFile(url, save, "overwrite");
			const mods = path.join(dir, "mods");
			await modsDir(host, request.modPack, mods);
			const factorioDir = path.resolve(host.config.get("host.factorio_directory"));
			const { bin, data } = await factorioInstall(factorioDir, request.factorioVersion);
			const msPerTick = await benchmark({ bin, data, mods, save, ticks: request.ticks, dir });
			const wallMs = Date.now() - started;
			const fields = { instance: request.instanceId, ms_per_tick: msPerTick, wall_ms: wallMs };
			lifecycle(logger, "balancer.preflight", "ran", fields);
			return { msPerTick, wallMs };
		} finally {
			// The sample that covers the run's end goes at once too.
			setTimeout(() => {
				local.preflights -= 1;
			}, SAMPLE_MS + 5_000).unref();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
}
