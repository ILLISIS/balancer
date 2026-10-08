import * as lib from "@clusterio/lib";
import { Type, type Static, type TSchema } from "@sinclair/typebox";

/** One 10-s sample (§4.1): when it ended, the UPS over it, the Factorio process's CPU ms per tick (null: unread). */
export const SampleSchema = Type.Object({
	at: Type.Number(),
	ups: Type.Number(),
	ms: Type.Union([Type.Number(), Type.Null()]),
});
export type Sample = Static<typeof SampleSchema>;

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** A move (§4.3 unit 2), as balancer.json keeps it. Each field a step needs is written before that step runs. */
export const MoveSchema = Type.Object({
	id: Type.String(),
	instanceId: Type.Integer(),
	/** The host it leaves; null for an instance with no host. */
	from: nullable(Type.Integer()),
	/** The target being pre-flighted or moved to; null while none is chosen. */
	to: nullable(Type.Integer()),
	reason: Type.Union([Type.Literal("manual"), Type.Literal("failover")]),
	/** The operator named the target: no other host is tried (plan ruling 11). */
	pinned: Type.Boolean(),
	step: Type.Union([
		Type.Literal("queued"), Type.Literal("preflight"), Type.Literal("stop"), Type.Literal("pull"),
		Type.Literal("assign"), Type.Literal("push"), Type.Literal("start"), Type.Literal("done"),
		Type.Literal("failed"),
	]),
	/** It ran when the move began, so it is started on the target (§5.3). */
	wasRunning: Type.Boolean(),
	/** Targets pre-flighted in this move. */
	tried: Type.Array(Type.Integer()),
	/** Failed tries of steps 4–6 since the last target change (§5.2: 3, then back to the source). */
	failures: Type.Integer(),
	/** Going back to its source with the same copy (§5.2). */
	back: Type.Boolean(),
	/** The save the stop writes (pulled at step 3), then the name the target stored the copy under (started at 6). */
	save: nullable(Type.String()),
	/** The tick read just before the stop: the start must load it or later (§5.2 step 6). */
	tick: nullable(Type.Integer()),
	startedAt: Type.Number(),
	endedAt: nullable(Type.Number()),
	error: nullable(Type.String()),
});
export type Move = Static<typeof MoveSchema>;
export type Step = Move["step"];

/** What `clusterioctl balancer status` and the page show (§11's minimal page). */
export const StatusSchema = Type.Object({
	hosts: Type.Array(Type.Object({
		id: Type.Integer(),
		name: Type.String(),
		connected: Type.Boolean(),
		/** When the balancer saw it go; null while it is connected. */
		goneSinceMs: nullable(Type.Number()),
	})),
	tiles: Type.Array(Type.Object({
		id: Type.Integer(),
		name: Type.String(),
		host: nullable(Type.Integer()),
		status: Type.String(),
		/** The last sample's UPS, and the last minute's mean CPU ms per tick. */
		ups: nullable(Type.Number()),
		ms: nullable(Type.Number()),
		players: Type.Integer(),
		/** The copy's save time on its host (its pull time until the new host saves); null without a copy. */
		copyMtimeMs: nullable(Type.Number()),
	})),
	moves: Type.Array(MoveSchema),
});
export type Status = Static<typeof StatusSchema>;

/** Instance → controller (§4.1): the samples since the last report; once a minute, or each one during a pre-flight. */
export class TelemetryEvent {
	declare ["constructor"]: typeof TelemetryEvent;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static plugin = "balancer" as const;

	constructor(public samples: Sample[]) { }

	static jsonSchema = Type.Object({ samples: Type.Array(SampleSchema) });

	static fromJSON(json: Static<typeof TelemetryEvent.jsonSchema>) {
		return new this(json.samples);
	}
}

/**
 * Controller → host (§5.2 step 1): download the stream's save (the controller's copy of the instance) and benchmark
 * it for `ticks` with the mod pack, next to this host's running tiles. Answers Factorio's average ms per tick.
 */
export class PreflightRequest {
	declare ["constructor"]: typeof PreflightRequest;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "host" as const;
	static plugin = "balancer" as const;

	constructor(
		public instanceId: number,
		public streamId: string,
		public modPack: lib.ModPack,
		public factorioVersion: string,
		public ticks: number,
	) { }

	static jsonSchema = Type.Object({
		instanceId: Type.Integer(),
		streamId: Type.String(),
		modPack: lib.ModPack.jsonSchema,
		factorioVersion: Type.String(),
		ticks: Type.Integer(),
	});

	static fromJSON(json: Static<typeof PreflightRequest.jsonSchema>) {
		const modPack = lib.ModPack.fromJSON(json.modPack);
		return new this(json.instanceId, json.streamId, modPack, json.factorioVersion, json.ticks);
	}

	static Response = lib.plainJson(Type.Object({ msPerTick: Type.Number(), wallMs: Type.Number() }));
}

/** Control → controller: move an instance with its save, to `hostId` or to the best target (§11's manual move). */
export class MoveRequest {
	declare ["constructor"]: typeof MoveRequest;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static plugin = "balancer" as const;
	static permission = "balancer.move" as const;

	constructor(public instanceId: number, public hostId?: number) { }

	static jsonSchema = Type.Object({ instanceId: Type.Integer(), hostId: Type.Optional(Type.Integer()) });

	static fromJSON(json: Static<typeof MoveRequest.jsonSchema>) {
		return new this(json.instanceId, json.hostId);
	}

	static Response = lib.plainJson(Type.Object({ moveId: Type.String() }));
}

/** Control → controller: hosts, tiles and moves, for the page and `clusterioctl balancer status`. */
export class StatusRequest {
	declare ["constructor"]: typeof StatusRequest;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static plugin = "balancer" as const;
	static permission = "balancer.view" as const;
	static Response = lib.plainJson(StatusSchema);
}

/**
 * Host → controller (§5.3): this host is shutting down cleanly and these instances are running; their stops that
 * follow must not hide that failover starts them on the target.
 */
export class HostLeavingEvent {
	declare ["constructor"]: typeof HostLeavingEvent;
	static type = "event" as const;
	static src = "host" as const;
	static dst = "controller" as const;
	static plugin = "balancer" as const;

	constructor(public running: number[]) { }

	static jsonSchema = Type.Object({ running: Type.Array(Type.Integer()) });

	static fromJSON(json: Static<typeof HostLeavingEvent.jsonSchema>) {
		return new this(json.running);
	}
}
