import * as lib from "@clusterio/lib";
import { MoveRequest, StatusRequest, type Status } from "./contracts.js";

/** The parts of clusterioctl's plugin context this entrypoint uses (CtlPluginContext lives in @clusterio/ctl). */
type CtlContext = { hooks: { addCommands: lib.AsyncHook<[lib.CommandTree]> }; plugin: { name: string } };

function out(text: string) {
	process.stdout.write(`${text}\n`);
}

/** One line per instance (host, status, UPS, CPU ms per tick, players, copy age), then one per move. */
export function statusText(s: Status, now = Date.now()): string[] {
	const lines = s.tiles.map(t => {
		const ups = t.ups === null ? "-" : t.ups.toFixed(1);
		const ms = t.ms === null ? "-" : t.ms.toFixed(2);
		const copy = t.copyMtimeMs === null ? "no copy" : `copy ${Math.round((now - t.copyMtimeMs) / 60_000)} min old`;
		return `${t.name} (${t.id}) host ${t.host ?? "-"} ${t.status} ups ${ups} ms ${ms} players ${t.players} ${copy}`;
	});
	for (const m of s.moves) {
		// C13, C30: a finished move that went back to its source shows why.
		let error = m.error === null ? "" : ` (${m.error})`;
		if (m.error !== null && m.back && m.step === "done") {
			error = ` returned: ${m.error}`;
		}
		const route = `${m.from ?? "-"} -> ${m.to ?? "?"}`;
		lines.push(`move ${m.id} ${m.reason} instance ${m.instanceId} ${route} ${m.step}${error}`);
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
		const { moveId } = await control.send(new MoveRequest(instanceId, hostId));
		out(moveId);
	},
}));

/** clusterioctl entrypoint: `clusterioctl balancer status|move`. */
export default async function loadCtlPlugin(context: CtlContext) {
	context.hooks.addCommands.attach(context.plugin.name, async rootCommand => {
		rootCommand.add(balancerCommands);
	});
}
