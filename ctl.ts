import * as lib from "@clusterio/lib";
import { BenchmarkRequest, DrainRequest, MoveRequest, StatusRequest, type Status } from "./contracts.js";

/** The parts of clusterioctl's plugin context this entrypoint uses (CtlPluginContext lives in @clusterio/ctl). */
type CtlContext = { hooks: { addCommands: lib.AsyncHook<[lib.CommandTree]> }; plugin: { name: string } };

function out(text: string) {
	process.stdout.write(`${text}\n`);
}

/** A host: connected or gone, its speed, its slots (learned ones marked), its busy tiles, and its drain (§4.4). */
function hostLine(h: Status["hosts"][number], hasTiles: boolean): string {
	const speed = h.speed === null ? "unbenchmarked" : `speed ${h.speed.toFixed(2)} ms`;
	const slots = h.slots === null ? "" : ` slots ${h.slots}${h.learned ? " (learned)" : ""}`;
	let flags = h.benchmarking ? " benchmarking" : "";
	if (h.draining) {
		flags = `${hasTiles ? " draining" : " drained"}${flags}`;
	}
	return `host ${h.name} (${h.id}) ${h.connected ? "connected" : "gone"} ${speed}${slots} busy ${h.busy}${flags}`;
}

/** The after-check's verdict (§5.6), once judged. */
function checkText(m: Status["moves"][number]): string {
	if (m.check === null) {
		return "";
	}
	if (m.check.ok === null) {
		return " check skipped";
	}
	return m.check.ok ? " check passed" : " check failed";
}

/** One line per host, per instance (host, status, UPS, CPU ms per tick, players, copy age), then per move. */
export function statusText(s: Status, now = Date.now()): string[] {
	const lines = s.hosts.map(h => hostLine(h, s.tiles.some(t => t.host === h.id)));
	lines.push(...s.tiles.map(t => {
		const ups = t.ups === null ? "-" : t.ups.toFixed(1);
		const ms = t.ms === null ? "-" : t.ms.toFixed(2);
		const copy = t.copyMtimeMs === null ? "no copy" : `copy ${Math.round((now - t.copyMtimeMs) / 60_000)} min old`;
		return `${t.name} (${t.id}) host ${t.host ?? "-"} ${t.status} ups ${ups} ms ${ms} players ${t.players} ${copy}`;
	}));
	for (const m of s.moves) {
		// C13, C30: a finished move that went back to its source shows why.
		let error = m.error === null ? "" : ` (${m.error})`;
		if (m.error !== null && m.back && m.step === "done") {
			error = ` returned: ${m.error}`;
		}
		const route = `${m.from ?? "-"} -> ${m.to ?? "?"}`;
		lines.push(`move ${m.id} ${m.reason} instance ${m.instanceId} ${route} ${m.step}${error}${checkText(m)}`);
	}
	return lines;
}

const balancerCommands = new lib.CommandTree({
	name: "balancer",
	description: "Balancer: move tiles between hosts with their saves",
});
balancerCommands.add(new lib.Command({
	definition: ["status", "Show each instance's host, UPS, CPU ms per tick, players and save copy, and the moves",
		yargs => {
			yargs.options({ json: { describe: "Print the response as JSON", type: "boolean", default: false } });
		}],
	handler: async (args: { json: boolean }, control: lib.Link) => {
		const s = await control.send(new StatusRequest());
		if (args.json) {
			out(JSON.stringify(s));
			return;
		}
		for (const line of statusText(s)) {
			out(line);
		}
	},
}));
balancerCommands.add(new lib.Command({
	definition: ["move <instance>", "Move an instance with its save: to --to, or to the host the balancer picks",
		yargs => {
			yargs.positional("instance", { describe: "Instance name or id", type: "string" });
			yargs.options({ to: { describe: "Target host name or id", type: "string" } });
		}],
	handler: async (args: { instance: string; to?: string }, control: lib.Link) => {
		const instanceId = await lib.resolveInstance(control, args.instance);
		const hostId = args.to === undefined ? undefined : await lib.resolveHost(control, args.to);
		const { moveId, warning } = await control.send(new MoveRequest(instanceId, hostId));
		if (warning) {
			process.stderr.write(`${warning}\n`);
		}
		out(moveId);
	},
}));

balancerCommands.add(new lib.Command({
	definition: ["drain <host>", "Drain a host: its empty tiles move away one at a time; nothing new is placed there",
		yargs => {
			yargs.positional("host", { describe: "Host name or id", type: "string" });
			yargs.options({ off: { describe: "Stop draining it", type: "boolean", default: false } });
		}],
	handler: async (args: { host: string; off: boolean }, control: lib.Link) => {
		const hostId = await lib.resolveHost(control, args.host);
		await control.send(new DrainRequest(hostId, !args.off));
	},
}));

balancerCommands.add(new lib.Command({
	definition: ["benchmark <host>", "Run the join benchmark on a host now: about 2 minutes, its tiles slow meanwhile",
		yargs => {
			yargs.positional("host", { describe: "Host name or id", type: "string" });
		}],
	handler: async (args: { host: string }, control: lib.Link) => {
		const hostId = await lib.resolveHost(control, args.host);
		await control.send(new BenchmarkRequest(hostId));
		out(`benchmark started on host ${hostId}; logs: ./dev logs --grep balancer.benchmark`);
	},
}));

/** clusterioctl entrypoint: `clusterioctl balancer status|move|drain|benchmark`. */
export default async function loadCtlPlugin(context: CtlContext) {
	context.hooks.addCommands.attach(context.plugin.name, async rootCommand => {
		rootCommand.add(balancerCommands);
	});
}
