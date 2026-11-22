import * as lib from "@clusterio/lib";
import { Type, type Static, type TSchema } from "@sinclair/typebox";

/**
 * One 10-s sample (§4.1): when it ended, the UPS over it, the Factorio process's CPU ms per tick over all threads
 * (null: unread), its memory figure in bytes (memory amendment §3.1; null: unread), and its main thread's CPU ms per
 * tick (capacity amendment C9; null: unread). `mem` and `mainMs` are optional, so a sample from before them still
 * validates (MR4).
 */
export const SampleSchema = Type.Object({
	at: Type.Number(),
	ups: Type.Number(),
	ms: Type.Union([Type.Number(), Type.Null()]),
	mem: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	mainMs: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
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
		Type.Literal("after_check"), Type.Literal("memory"), Type.Literal("room"),
	]),
	/**
	 * Capacity amendment C5: an overload move of its host's only lagging tile: it is pre-flighted on its own host and
	 * on every candidate, and goes to the measured winner or nowhere. Optional: a move from before C5 has none.
	 */
	measure: Type.Optional(Type.Boolean()),
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
	 * running tiles then, which a failed after-check makes the target's cap (capacity amendment C3). `tiles` is
	 * optional: a move from before the amendment has none (and a `busy` nothing reads).
	 */
	preflight: nullable(Type.Object({
		msPerTick: nullable(Type.Number()), minUps: nullable(Type.Number()), tiles: Type.Optional(Type.Integer()),
	})),
	/**
	 * The after-check (§5.6, R9): T's mean UPS and ms per tick on the target, the lowest mean UPS among the target's
	 * other tiles (capacity amendment C6), and the verdict; ok is null when it couldn't be judged.
	 */
	check: nullable(Type.Object({
		at: Type.Number(), ups: nullable(Type.Number()), ms: nullable(Type.Number()),
		othersMinUps: nullable(Type.Number()), ok: nullable(Type.Boolean()),
	})),
});
export type Move = Static<typeof MoveSchema>;
export type Step = Move["step"];
export type Check = NonNullable<Move["check"]>;

/**
 * Capacity amendment C8: why a tile isn't offered to a host again, and since when (ms). `overload`: it left that host
 * as its only lagging tile or as its heaviest empty one; `slow`: its own mean UPS was under the floor in its
 * after-check there. No expiry: the owner clears it.
 */
export const MarkSchema = Type.Object({
	reason: Type.Union([Type.Literal("overload"), Type.Literal("slow")]),
	at: Type.Number(),
});
export type Mark = Static<typeof MarkSchema>;
/** A mark's reason as the page and `clusterioctl balancer status` word it. */
export const MARK_TEXT: Record<Mark["reason"], string> = {
	overload: "left it under overload",
	slow: "ran under the UPS floor there",
};

/**
 * Capacity amendment C7: room is being made on `host` for tile `instanceId`, its measured winner, until `until` (ms).
 * One at most.
 */
export const ReserveSchema = Type.Object({ instanceId: Type.Integer(), host: Type.Integer(), until: Type.Number() });
export type Reserve = Static<typeof ReserveSchema>;
/** C7 step 2: how long a reservation stands. */
export const RESERVE_MS = 30 * 60_000;

/** What `clusterioctl balancer status` and the page show (§11's minimal page). */
export const StatusSchema = Type.Object({
	hosts: Type.Array(Type.Object({
		id: Type.Integer(),
		name: Type.String(),
		connected: Type.Boolean(),
		/** When the balancer saw it go; null while it is connected. */
		goneSinceMs: nullable(Type.Number()),
		/** Capacity amendment C2: its core count; null until it reports one. */
		cores: nullable(Type.Integer()),
		/** C3: the running tiles it carries at most, and until when (ms); null: uncapped. */
		cap: nullable(Type.Object({ tiles: Type.Integer(), until: Type.Number() })),
		draining: Type.Boolean(),
		/**
		 * Memory amendment §3.2: the percent of its memory in use (null: no reading 60 s old or newer), its
		 * balancer.memory_limit_pct, and its room for a new tile in bytes (negative over the limit).
		 */
		usedPct: nullable(Type.Number()),
		limitPct: Type.Number(),
		room: Type.Number(),
	})),
	tiles: Type.Array(Type.Object({
		id: Type.Integer(),
		name: Type.String(),
		host: nullable(Type.Integer()),
		status: Type.String(),
		/** The last sample's UPS, and the last minute's mean CPU ms per tick: all threads, and the main thread (C9). */
		ups: nullable(Type.Number()),
		ms: nullable(Type.Number()),
		mainMs: nullable(Type.Number()),
		players: Type.Integer(),
		/** The copy's save time on its host (its pull time until the new host saves); null without a copy. */
		copyMtimeMs: nullable(Type.Number()),
		/** Memory amendment §3.1: its need, bytes: its figure × 1.2, or the no-figure estimate. */
		need: Type.Number(),
	})),
	moves: Type.Array(MoveSchema),
	/** Capacity amendment C8: the marked pairs. */
	marks: Type.Array(Type.Object({ instanceId: Type.Integer(), hostId: Type.Integer(), mark: MarkSchema })),
	/** Capacity amendment C7: the outstanding reservation; null: none. */
	reserve: nullable(ReserveSchema),
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

	static Response = lib.plainJson(Type.Object({ moveId: Type.String(), warning: Type.Optional(Type.String()) }));
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

/**
 * Host → controller every 10 s, at each connect and when balancer.memory_limit_pct changes (memory amendment §3.2,
 * MR-C1): this host's limit, the machine's memory in bytes as Clusterio's SystemInfo reads it (os.totalmem(),
 * os.freemem()), and its core count (capacity amendment C2: os.availableParallelism(); absent from a host on the
 * build before it: no core count yet). The controller keeps them in memory only, the reading stamped with its own
 * clock.
 */
export class HostMemoryEvent {
	declare ["constructor"]: typeof HostMemoryEvent;
	static type = "event" as const;
	static src = "host" as const;
	static dst = "controller" as const;
	static plugin = "balancer" as const;

	constructor(
		public limitPct: number, public capacity: number, public available: number, public cores?: number,
	) { }

	static jsonSchema = Type.Object({
		limitPct: Type.Number(), capacity: Type.Number(), available: Type.Number(),
		cores: Type.Optional(Type.Integer()),
	});

	static fromJSON(json: Static<typeof HostMemoryEvent.jsonSchema>) {
		return new this(json.limitPct, json.capacity, json.available, json.cores);
	}
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

/**
 * Control → controller (capacity amendment C8): clear the mark of `instanceId` on `hostId`, or, with no instance, all
 * of that host's (its hardware changed). Answers how many it cleared.
 */
export class ClearMarksRequest {
	declare ["constructor"]: typeof ClearMarksRequest;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static plugin = "balancer" as const;
	static permission = "balancer.move" as const;

	constructor(public hostId: number, public instanceId?: number) { }

	static jsonSchema = Type.Object({ hostId: Type.Integer(), instanceId: Type.Optional(Type.Integer()) });

	static fromJSON(json: Static<typeof ClearMarksRequest.jsonSchema>) {
		return new this(json.hostId, json.instanceId);
	}

	static Response = lib.plainJson(Type.Object({ cleared: Type.Integer() }));
}
