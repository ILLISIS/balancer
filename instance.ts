import type { InstancePluginContext } from "@clusterio/host";
import { TelemetryEvent, type Sample } from "./contracts.js";
import { local } from "./local.js";
import { REPORT_EVERY, SAMPLE_MS, cpuMs, sample, type Reading } from "./telemetry.js";

/**
 * The instance plugin (§4.1): every 10 s, game.tick over RCON and the Factorio process's CPU time. The samples go to
 * the controller once a minute, or each one at once while this host runs a pre-flight (`local.preflights`).
 */
export default async function loadInstancePlugin(context: InstancePluginContext) {
	const { instance, logger, plugin } = context;
	let timer: ReturnType<typeof setInterval> | undefined;
	let prev: Reading | undefined;
	let pending: Sample[] = [];

	const read = async (): Promise<Reading | undefined> => {
		const reply = (await instance.sendRcon("/sc rcon.print(game.tick)")).trim();
		const tick = Number(reply);
		if (!/^\d+$/.test(reply)) {
			return undefined; // e.g. Factorio's one-time achievements warning before a save's first Lua command
		}
		const pid = instance.server.pid;
		return { tick, cpuMs: pid ? await cpuMs(pid) : null, at: Date.now() };
	};

	const poll = async () => {
		let next: Reading | undefined;
		try {
			next = await read();
		} catch (err: any) {
			logger.verbose(`balancer: telemetry read failed: ${err.message}`);
			return;
		}
		if (!next) {
			return;
		}
		const s = prev ? sample(prev, next) : undefined;
		prev = next;
		if (s) {
			pending.push(s);
		}
		if (pending.length >= REPORT_EVERY || (pending.length > 0 && local.preflights > 0)) {
			const samples = pending;
			pending = [];
			try {
				instance.sendTo("controller", new TelemetryEvent(samples));
			} catch (err: any) {
				logger.verbose(`balancer: telemetry not sent: ${err.message}`);
			}
		}
	};

	const stop = async () => {
		clearInterval(timer);
		timer = undefined;
	};
	instance.hooks.start.attach(plugin.name, async () => {
		prev = undefined;
		pending = [];
		timer = setInterval(() => {
			void poll();
		}, SAMPLE_MS);
	});
	instance.hooks.stop.attach(plugin.name, stop);
	instance.hooks.exit.attach(plugin.name, stop);
}
