import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as lib from "@clusterio/lib";
import type { HostPluginContext } from "@clusterio/host";
import { lifecycle } from "universal_edges/runtime";
import {
	FactorioVersionEvent, HostBenchmarkRequest, HostLeavingEvent, HostMemoryEvent, PreflightRequest,
} from "./contracts.js";
import { Fence, fenceEvent, stopLive } from "./fence.js";
import { local } from "./local.js";
import { benchmark, factorioInstall, joinBenchmark, modsDir } from "./preflight.js";
import { SAMPLE_MS } from "./telemetry.js";

/** The host plugin (§4.2): the fence (§7), the pre-flight (§5.2 step 1) and the join benchmark (§5.7). */
export default async function loadHostPlugin(context: HostPluginContext) {
	const { host, logger, plugin } = context;

	// §7, B10: cut off for balancer.fence_minutes, this host saves and stops its own tiles.
	const fence = new Fence(() => host.config.get("balancer.fence_minutes"), () => {
		const live = [...host.instanceConnections.values()].map(c => c.instance)
			.filter(i => i.status === "starting" || i.status === "running");
		lifecycle(logger, "balancer.fence", "fired", { instances: live.map(i => i.id) }, "warn");
		stopLive(live, (phase, fields, level) => lifecycle(logger, "balancer.fence", phase, fields, level));
	});
	const factorioDir = () => path.resolve(host.config.get("host.factorio_directory"));
	/**
	 * Memory amendment §3.2, MR-C1: this host's limit and the machine's memory, for the controller, which keeps them in
	 * memory only: at each connect, when the limit changes, and every SAMPLE_MS (a reading older than 60 s gives the
	 * host no room). Not while cut off: a resumed session would replay old readings, which the controller stamps new.
	 */
	const reportMemory = () => {
		if (!host.connected) {
			return;
		}
		try {
			host.send(new HostMemoryEvent(host.config.get("balancer.memory_limit_pct"), os.totalmem(), os.freemem()));
		} catch (err: any) {
			logger.verbose(`balancer: HostMemoryEvent not sent: ${err.message}`);
		}
	};
	setInterval(reportMemory, SAMPLE_MS).unref();
	host.hooks.controllerConnectionEvent.attach(plugin.name, async event => {
		fence.event(fenceEvent(event, host._shuttingDown));
		if (event === "connect") {
			// §5.7, R8: the controller benchmarks this host again when its Factorio changes.
			factorioInstall(factorioDir(), "latest").then(f => host.send(new FactorioVersionEvent(f.version))).catch(
				(err: Error) => logger.warn(`balancer: the Factorio version was not reported: ${err.message}`),
			);
			reportMemory();
		}
	});
	host.hooks.hostConfigFieldChanged.attach(plugin.name, async field => {
		if (field === "balancer.memory_limit_pct") {
			reportMemory();
		}
	});

	/** The stream's save into `dir`, its mods dir (none for a null pack: P5), and Factorio `version`'s install. */
	const prepare = async (dir: string, streamId: string, modPack: lib.ModPack | null, version: string) => {
		const url = new URL(host.config.get("host.controller_url"));
		url.pathname += `api/stream/${streamId}`;
		const save = path.join(dir, "save.zip");
		await lib.downloadFile(url, save, "overwrite");
		const mods = path.join(dir, "mods");
		await (modPack ? modsDir(host, modPack, mods) : fs.mkdir(mods));
		const { bin, data } = await factorioInstall(factorioDir(), version);
		return { bin, data, mods, save };
	};

	// §5.3: a clean shutdown stops the instances before it disconnects; say which were running first (C34).
	host.hooks.shutdown.attach(plugin.name, async () => {
		fence.event("connect"); // C52: an armed timer would hold the exit up
		const running = [...host.instanceConnections.values()].map(c => c.instance)
			.filter(i => i.status === "starting" || i.status === "running").map(i => i.id);
		if (running.length > 0) {
			try {
				host.send(new HostLeavingEvent(running));
			} catch (err: any) {
				// The session is gone already (controller down): there is nobody to tell.
				logger.verbose(`balancer: HostLeavingEvent not sent: ${err.message}`);
			}
		}
	});

	// §5.2 step 1: benchmark the controller's copy of a tile here, next to this host's running tiles.
	host.handle(PreflightRequest, async (request: PreflightRequest) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "balancer-preflight-"));
		local.preflights += 1; // this host's instances report every sample until it ends (§4.1)
		const started = Date.now();
		try {
			const run = await prepare(dir, request.streamId, request.modPack, request.factorioVersion);
			const msPerTick = await benchmark({ ...run, ticks: request.ticks, dir });
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

	// §5.7: the join benchmark on the controller's reference save (P5), with its mod pack or none. The save is streamed
	// to this host per run (M11).
	host.handle(HostBenchmarkRequest, async (request: HostBenchmarkRequest) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "balancer-benchmark-"));
		const started = Date.now();
		try {
			const run = await prepare(dir, request.streamId, request.modPack, request.factorioVersion);
			const cores = os.availableParallelism();
			// Memory amendment §3.4 (M7): no more copies than the controller found room for.
			const r = await joinBenchmark(run, path.join(dir, "runs"), Math.min(cores, request.maxCopies));
			const fields = {
				speed: r.speed, slots: r.slots, cores, max_copies: request.maxCopies, runs: r.runs,
				wall_ms: Date.now() - started,
			};
			lifecycle(logger, "balancer.benchmark", "ran", fields);
			return { ...r, cores };
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
}
