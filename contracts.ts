import * as lib from "@clusterio/lib";
import { Type, type Static, type TSchema } from "@sinclair/typebox";

/**
 * One 10-s sample (§4.1): when it ended, the UPS over it, the Factorio process's CPU ms per tick (null: unread), and
 * its memory figure in bytes (memory amendment §3.1; null: unread). `mem` is optional, so a sample from before it
 * still validates (MR4).
 */
export const SampleSchema = Type.Object({
	at: Type.Number(),
	ups: Type.Number(),
	ms: Type.Union([Type.Number(), Type.Null()]),
	mem: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
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
	reason: Type.Union([
		Type.Literal("manual"), Type.Literal("failover"), Type.Literal("drain"), Type.Literal("overload"),
		Type.Literal("after_check"), Type.Literal("memory"),
	]),
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
	/**
	 * The last pre-flight's verdict (the ledger, §4.3 unit 4): T's ms per tick there, the target's lowest UPS, and its
	 * busy tiles then, which a failed after-check makes the target's slots (§5.6).
	 */
	preflight: nullable(Type.Object({
		msPerTick: nullable(Type.Number()), minUps: nullable(Type.Number()), busy: Type.Integer(),
	})),
	/**
	 * The after-check (§5.6, R9): T's mean UPS and ms per tick on the target, the lowest UPS of the target's other
	 * tiles, and the verdict; ok is null when it couldn't be judged.
	 */
	check: nullable(Type.Object({
		at: Type.Number(), ups: nullable(Type.Number()), ms: nullable(Type.Number()),
		othersMinUps: nullable(Type.Number()), ok: nullable(Type.Boolean()),
	})),
});
export type Move = Static<typeof MoveSchema>;
export type Step = Move["step"];
export type Check = NonNullable<Move["check"]>;

/** What `clusterioctl balancer status` and the page show (§11's minimal page). */
export const StatusSchema = Type.Object({
	hosts: Type.Array(Type.Object({
		id: Type.Integer(),
		name: Type.String(),
		connected: Type.Boolean(),
		/** When the balancer saw it go; null while it is connected. */
		goneSinceMs: nullable(Type.Number()),
		/** The join benchmark's ms per tick with one copy (§5.7); null: unbenchmarked. */
		speed: nullable(Type.Number()),
		/** The busy tiles it takes: learned (§5.6) or the benchmark's; null: no limit. */
		slots: nullable(Type.Integer()),
		learned: Type.Boolean(),
		/** Its running tiles at balancer.busy_tile_ms or more. */
		busy: Type.Integer(),
		draining: Type.Boolean(),
		benchmarking: Type.Boolean(),
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

/** Host → controller at each connect (R8): its newest Factorio; the join benchmark re-runs when it changes (§5.7). */
export class FactorioVersionEvent {
	declare ["constructor"]: typeof FactorioVersionEvent;
	static type = "event" as const;
	static src = "host" as const;
	static dst = "controller" as const;
	static plugin = "balancer" as const;

	constructor(public version: string) { }

	static jsonSchema = Type.Object({ version: Type.String() });

	static fromJSON(json: Static<typeof FactorioVersionEvent.jsonSchema>) {
		return new this(json.version);
	}
}

/**
 * Host → controller every 10 s, at each connect and when balancer.memory_limit_pct changes (memory amendment §3.2,
 * MR-C1): this host's limit, and the machine's memory in bytes as Clusterio's SystemInfo reads it (os.totalmem(),
 * os.freemem()). The controller keeps both in memory only, the reading stamped with its own clock.
 */
export class HostMemoryEvent {
	declare ["constructor"]: typeof HostMemoryEvent;
	static type = "event" as const;
	static src = "host" as const;
	static dst = "controller" as const;
	static plugin = "balancer" as const;

	constructor(public limitPct: number, public capacity: number, public available: number) { }

	static jsonSchema = Type.Object({ limitPct: Type.Number(), capacity: Type.Number(), available: Type.Number() });

	static fromJSON(json: Static<typeof HostMemoryEvent.jsonSchema>) {
		return new this(json.limitPct, json.capacity, json.available);
	}
}

/**
 * Controller → host (§5.7): download the stream's reference save and run the join benchmark on it with `modPack` (null:
 * no mods, P5) on Factorio `factorioVersion`, at most `maxCopies` copies at once (memory amendment §3.4, M7). Answers
 * the speed, the slots, the cores and each count's ms per tick.
 */
export class HostBenchmarkRequest {
	declare ["constructor"]: typeof HostBenchmarkRequest;
	static type = "request" as const;
	static src = "controller" as const;
	static dst = "host" as const;
	static plugin = "balancer" as const;

	constructor(
		public streamId: string,
		public modPack: lib.ModPack | null,
		public factorioVersion: string,
		public maxCopies: number,
	) { }

	static jsonSchema = Type.Object({
		streamId: Type.String(),
		modPack: nullable(lib.ModPack.jsonSchema),
		factorioVersion: Type.String(),
		maxCopies: Type.Integer(),
	});

	static fromJSON(json: Static<typeof HostBenchmarkRequest.jsonSchema>) {
		const modPack = json.modPack === null ? null : lib.ModPack.fromJSON(json.modPack);
		return new this(json.streamId, modPack, json.factorioVersion, json.maxCopies);
	}

	static Response = lib.plainJson(Type.Object({
		speed: Type.Number(),
		slots: Type.Integer(),
		cores: Type.Integer(),
		runs: Type.Array(Type.Object({ copies: Type.Integer(), msPerTick: Type.Number() })),
	}));
}

/** Control → controller (§5.4): start or stop draining a host. Drain runs whatever balancer.enabled says (P4). */
export class DrainRequest {
	declare ["constructor"]: typeof DrainRequest;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static plugin = "balancer" as const;
	static permission = "balancer.move" as const;

	constructor(public hostId: number, public on: boolean) { }

	static jsonSchema = Type.Object({ hostId: Type.Integer(), on: Type.Boolean() });

	static fromJSON(json: Static<typeof DrainRequest.jsonSchema>) {
		return new this(json.hostId, json.on);
	}
}

/** Control → controller (§5.7): "benchmark now" on a host. */
export class BenchmarkRequest {
	declare ["constructor"]: typeof BenchmarkRequest;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static plugin = "balancer" as const;
	static permission = "balancer.move" as const;

	constructor(public hostId: number) { }

	static jsonSchema = Type.Object({ hostId: Type.Integer() });

	static fromJSON(json: Static<typeof BenchmarkRequest.jsonSchema>) {
		return new this(json.hostId);
	}
}
