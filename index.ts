import type * as lib from "@clusterio/lib";
import {
	ClearMarksRequest, DrainRequest, HostLeavingEvent, HostMemoryEvent, MoveRequest, PreflightRequest, StatusRequest,
	TelemetryEvent,
} from "./contracts.js";

declare module "@clusterio/lib" {
	export interface ControllerConfigFields {
		"balancer.enabled": boolean;
		"balancer.failover_grace_minutes": number;
		"balancer.ups_floor": number;
		"balancer.failover_floor": number;
		"balancer.lag_minutes": number;
		"balancer.after_check_minutes": number;
		"balancer.max_concurrent_moves": number;
		"balancer.bad_pair_hours": number;
	}
	export interface HostConfigFields {
		"balancer.fence_minutes": number;
		"balancer.memory_limit_pct": number;
	}
	export interface Permissions {
		"balancer.view": never;
		"balancer.move": never;
	}
}

const number = (title: string, description: string, initialValue: number) => (
	{ title, description, type: "number" as const, initialValue }
);

export const plugin: lib.PluginDeclaration = {
	name: "balancer",
	title: "Balancer",
	description: "Moves empty tiles between hosts with their saves, fails over gone hosts and fences cut-off ones.",
	controllerEntrypoint: "dist/node/controller.js",
	hostEntrypoint: "dist/node/host.js",
	instanceEntrypoint: "dist/node/instance.js",
	ctlEntrypoint: "dist/node/ctl.js",
	webEntrypoint: "./web",
	routes: ["/balancer"],
	// The instance plugin reads game.tick with /sc (§4.1).
	features: ["ScriptCommands"],
	controllerConfigFields: {
		"balancer.enabled": {
			title: "Enabled",
			description: "The automatic rules: failover, overload and the after-check's re-move. Drain, manual " +
				"moves and save copies run either way. After-checks are still judged and recorded.",
			type: "boolean",
			initialValue: true,
		},
		"balancer.failover_grace_minutes": number(
			"Failover grace",
			"Minutes a host may stay disconnected before its tiles move (§5.3). Keep it above every host's fence.",
			15,
		),
		"balancer.ups_floor": number(
			"UPS floor", "A target's tiles must stay at this UPS or above, in the pre-flight and to be eligible.", 58,
		),
		"balancer.failover_floor": number(
			"Failover floor",
			"When no host is eligible, a gone host's tile may go to a host whose tiles stay at this UPS or above " +
			"(live and in its pre-flight). Below balancer.ups_floor. Every pre-flight fails a tile that " +
			"benchmarks at 1000 / this many ms per tick or more.",
			45,
		),
		"balancer.max_concurrent_moves": number("Concurrent moves", "Moves in progress at once in the cluster.", 3),
		"balancer.bad_pair_hours": number(
			"Bad pair hours",
			"Hours a tile isn't offered again to a host after a failed pre-flight or after-check, and hours a host " +
			"whose tiles slowed after a tile arrived takes no more tiles than it carried before.",
			24,
		),
		"balancer.lag_minutes": number(
			"Lag minutes",
			"A tile under the UPS floor this long overloads its host (§5.5). Values above 4 act as 4: the " +
			"controller keeps 5 minutes of samples.",
			3,
		),
		"balancer.after_check_minutes": number(
			"After-check", "Minutes after a move until it is judged on its target, by its last 5 minutes (§5.6).", 10,
		),
	},
	hostConfigFields: {
		"balancer.fence_minutes": number(
			"Fence",
			"Minutes without the controller after which this host saves and stops its own tiles (§7). " +
			"Keep it below the controller's balancer.failover_grace_minutes.",
			12,
		),
		"balancer.memory_limit_pct": number(
			"Memory limit",
			"Percent of this machine's memory the balancer fills: a tile goes to this host only while its peak " +
			"memory (× 1.2) keeps the machine at or under it, and above it for balancer.lag_minutes an empty tile " +
			"moves away. Raise it on a machine with plenty of memory.",
			90,
		),
	},
	messages: [
		HostLeavingEvent, TelemetryEvent, PreflightRequest, MoveRequest, StatusRequest, DrainRequest, HostMemoryEvent,
		ClearMarksRequest,
	],
	permissions: [
		{
			name: "balancer.view",
			title: "View the balancer",
			description: "See hosts, tiles, save copies and moves.",
			grantByDefault: true,
		},
		{
			name: "balancer.move",
			title: "Move tiles",
			description: "Move tiles, drain hosts and clear a host's marks.",
		},
	],
};
