import type * as lib from "@clusterio/lib";
import { HostLeavingEvent, MoveRequest, PreflightRequest, StatusRequest, TelemetryEvent } from "./contracts.js";

declare module "@clusterio/lib" {
	export interface ControllerConfigFields {
		"balancer.enabled": boolean;
		"balancer.failover_grace_minutes": number;
		"balancer.ups_floor": number;
		"balancer.busy_tile_ms": number;
		"balancer.preflight_max_ms": number;
		"balancer.max_concurrent_moves": number;
		"balancer.bad_pair_hours": number;
	}
	export interface HostConfigFields {
		"balancer.fence_minutes": number;
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
	// The instance plugin reads game.tick with /sc (§4.1).
	features: ["ScriptCommands"],
	controllerConfigFields: {
		"balancer.enabled": {
			title: "Enabled",
			description: "Automatic actions (phase 1: failover). Manual moves and save copies run either way.",
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
		"balancer.busy_tile_ms": number("Busy tile", "CPU ms per tick from which a tile counts as busy (§5.8).", 2),
		"balancer.preflight_max_ms": number(
			"Pre-flight limit", "The pre-flight fails when the tile benchmarks at this many ms per tick or more.", 10,
		),
		"balancer.max_concurrent_moves": number("Concurrent moves", "Moves in progress at once in the cluster.", 3),
		"balancer.bad_pair_hours": number(
			"Bad pair hours", "Hours a tile isn't offered again to a host whose pre-flight it failed.", 24,
		),
	},
	hostConfigFields: {
		"balancer.fence_minutes": number(
			"Fence",
			"Minutes without the controller after which this host saves and stops its own tiles (§7). " +
			"Keep it below the controller's balancer.failover_grace_minutes.",
			12,
		),
	},
	messages: [HostLeavingEvent, TelemetryEvent, PreflightRequest, MoveRequest, StatusRequest],
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
			description: "Move a tile to another host with its save.",
		},
	],
};
