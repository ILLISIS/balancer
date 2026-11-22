import * as lib from "@clusterio/lib";
import { ClearMarksRequest, DrainRequest, MARK_TEXT, MoveRequest, StatusRequest, type Status } from "./contracts.js";

/** The parts of clusterioctl's plugin context this entrypoint uses (CtlPluginContext lives in @clusterio/ctl). */
type CtlContext = { hooks: { addCommands: lib.AsyncHook<[lib.CommandTree]> }; plugin: { name: string } };

/**
 * Print a line of the command's result. Through clusterioctl's output (2.1, clusterio/clusterio#1230), so ctl doesn't
 * add "Command ran successfully" after it; a plain write on a ctl without one.
 */
function out(control: lib.Link, text: string) {
	const write = () => process.stdout.write(`${text}\n`);
	const output = (control as lib.Link & { output?: { result(data: unknown, human: () => void): void } }).output;
	if (output) {
		output.result(text, write);
	} else {
		write();
	}
}

/** A host: connected or gone, its cores, its cap (capacity amendment C3), and its drain (§4.4). */
function hostLine(h: Status["hosts"][number], hasTiles: boolean): string {
	const cores = h.cores === null ? "" : ` ${h.cores} cores`;
	const cap = h.cap === null
		? "" : ` capped at ${h.cap.tiles} until ${new Date(h.cap.until).toTimeString().slice(0, 5)}`;
	let drain = "";
	if (h.draining) {
		drain = hasTiles ? " draining" : " drained";
	}
	return `host ${h.name} (${h.id}) ${h.connected ? "connected" : "gone"}${cores}${cap}${drain}`;
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

/**
 * One line per host, per instance (host, status, UPS, CPU ms per tick on the main thread and over all threads,
 * players, copy age), per marked pair (capacity amendment C8), the reservation if one stands (C7), then per move.
 */
export function statusText(s: Status, now = Date.now()): string[] {
	const lines = s.hosts.map(h => hostLine(h, s.tiles.some(t => t.host === h.id)));
	lines.push(...s.tiles.map(t => {
		const ups = t.ups === null ? "-" : t.ups.toFixed(1);
		const ms = `main ${t.mainMs === null ? "-" : t.mainMs.toFixed(2)} all ${t.ms === null ? "-" : t.ms.toFixed(2)}`;
		const copy = t.copyMtimeMs === null ? "no copy" : `copy ${Math.round((now - t.copyMtimeMs) / 60_000)} min old`;
		return `${t.name} (${t.id}) host ${t.host ?? "-"} ${t.status} ups ${ups} ms ${ms} players ${t.players} ${copy}`;
	}));
	lines.push(...s.marks.map(({ instanceId, hostId, mark }) => {
		const since = new Date(mark.at).toISOString().slice(0, 10);
		return `mark instance ${instanceId} host ${hostId} since ${since}: ${MARK_TEXT[mark.reason]}`;
	}));
	if (s.reserve) {
		const until = new Date(s.reserve.until).toTimeString().slice(0, 5);
		lines.push(`reserve instance ${s.reserve.instanceId} host ${s.reserve.host} until ${until}: making room`);
	}
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
			out(control, JSON.stringify(s));
			return;
		}
		for (const line of statusText(s)) {
			out(control, line);
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
		out(control, moveId);
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
	definition: [
		"unmark <host>",
		"Clear a host's marks, so the tiles that left it for cause are offered to it again: all, or --instance's",
		yargs => {
			yargs.positional("host", { describe: "Host name or id", type: "string" });
			yargs.options({ instance: { describe: "Only this instance's mark: its name or id", type: "string" } });
		},
	],
	handler: async (args: { host: string; instance?: string }, control: lib.Link) => {
		const hostId = await lib.resolveHost(control, args.host);
		const instanceId = args.instance === undefined ? undefined : await lib.resolveInstance(control, args.instance);
		const { cleared } = await control.send(new ClearMarksRequest(hostId, instanceId));
		out(control, `cleared ${cleared}`);
	},
}));

/** clusterioctl entrypoint: `clusterioctl balancer status|move|drain|unmark`. */
export default async function loadCtlPlugin(context: CtlContext) {
	context.hooks.addCommands.attach(context.plugin.name, async rootCommand => {
		rootCommand.add(balancerCommands);
	});
}
