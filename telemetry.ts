import * as fs from "node:fs/promises";
import type { Sample } from "./contracts.js";

/** §4.1: an instance reads its tick and its CPU time every 10 s, and reports once a minute. */
export const SAMPLE_MS = 10_000;
export const REPORT_EVERY = 6;
/** The controller keeps 5 minutes per instance: a pre-flight's window and the last minute's mean fit. */
const KEEP_MS = 300_000;
/** ponytail: x86-64 Linux's USER_HZ; read `getconf CLK_TCK` if a host ever differs. */
const CLK_TCK = 100;

export type Reading = { tick: number; cpuMs: number | null; at: number };

/** A sample from two readings; undefined when the tick or the clock didn't advance (a restarted or paused game). */
export function sample(prev: Reading, next: Reading): Sample | undefined {
	const ticks = next.tick - prev.tick;
	const elapsed = next.at - prev.at;
	if (ticks <= 0 || elapsed <= 0) {
		return undefined;
	}
	const ms = prev.cpuMs === null || next.cpuMs === null ? null : (next.cpuMs - prev.cpuMs) / ticks;
	return { at: next.at, ups: ticks * 1000 / elapsed, ms };
}

/**
 * A process's CPU time (user + system) in ms, from /proc/<pid>/stat; null where there is no /proc or no such process
 * (plan ruling 3). The whole process: Factorio's worker threads count too.
 */
export async function cpuMs(pid: number): Promise<number | null> {
	try {
		const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
		// After "(comm) " the fields count from 3 (state): utime is field 14, stime field 15.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return (Number(fields[11]) + Number(fields[12])) * 1000 / CLK_TCK;
	} catch {
		return null;
	}
}

/** The controller's recent samples, per instance. */
export class Telemetry {
	private samples = new Map<number, Sample[]>();

	constructor(private now: () => number = Date.now) { }

	/**
	 * Store a host's report. Host clocks can be off by tens of seconds, so the newest sample is placed at this
	 * controller's now and the others keep their spacing from it (ruling C2).
	 */
	receive(instanceId: number, samples: Sample[]): void {
		const newest = Math.max(...samples.map(s => s.at));
		const now = this.now();
		this.add(instanceId, samples.map(s => ({ ...s, at: now - (newest - s.at) })));
	}

	add(instanceId: number, samples: Sample[]): void {
		this.samples.set(instanceId, [...this.recent(instanceId), ...samples]);
	}

	/** The newest sample of the last 5 minutes. */
	last(instanceId: number): Sample | undefined {
		return this.recent(instanceId).at(-1);
	}

	/** The lowest UPS of the samples that ended in (from, to]; undefined when none did. */
	minUps(instanceId: number, from: number, to: number): number | undefined {
		const ups = this.recent(instanceId).filter(s => s.at > from && s.at <= to).map(s => s.ups);
		return ups.length > 0 ? Math.min(...ups) : undefined;
	}

	/** The mean CPU ms per tick of the last minute's samples that have one. */
	meanMs(instanceId: number): number | undefined {
		const since = this.now() - 60_000;
		const ms = this.recent(instanceId).flatMap(s => (s.at > since && s.ms !== null ? [s.ms] : []));
		return ms.length > 0 ? ms.reduce((a, b) => a + b, 0) / ms.length : undefined;
	}

	private recent(instanceId: number): Sample[] {
		const since = this.now() - KEEP_MS;
		return (this.samples.get(instanceId) ?? []).filter(s => s.at > since);
	}
}
