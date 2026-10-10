import * as fs from "node:fs/promises";
import type { Sample } from "./contracts.js";

/** §4.1: an instance reads its tick and its CPU time every 10 s, and reports once a minute. */
export const SAMPLE_MS = 10_000;
export const REPORT_EVERY = 6;
/** The controller keeps 5 minutes per instance: a pre-flight's window and the last minute's mean fit. */
export const KEEP_MS = 300_000;
/** ponytail: x86-64 Linux's USER_HZ; read `getconf CLK_TCK` if a host ever differs. */
const CLK_TCK = 100;

/** Two readings make a sample; `mem` is the process's memory figure (memory amendment §3.1), null: unread. */
export type Reading = { tick: number; cpuMs: number | null; at: number; mem?: number | null };

/**
 * A sample from two readings; undefined when the tick or the clock didn't advance (a restarted or paused game).
 * `stallMs`, the time blocking autosaves stalled the tick loop in between, is left out of the elapsed time (P1). Its
 * memory figure is the newer reading's.
 */
export function sample(prev: Reading, next: Reading, stallMs = 0): Sample | undefined {
	const ticks = next.tick - prev.tick;
	const elapsed = next.at - prev.at - stallMs;
	if (ticks <= 0 || elapsed <= 0) {
		return undefined;
	}
	const ms = prev.cpuMs === null || next.cpuMs === null ? null : (next.cpuMs - prev.cpuMs) / ticks;
	return { at: next.at, ups: ticks * 1000 / elapsed, ms, mem: next.mem ?? null };
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

/**
 * Memory amendment §3.1: a process's memory figure from its /proc/<pid>/status text, max(VmHWM, VmRSS + VmSwap) in
 * bytes. The peak misses pages swapped out before it, so the resident and swapped pages count too. Null when the text
 * names none of them.
 */
export function memFigure(status: string): number | null {
	const kb = (field: string) => Number(new RegExp(`^${field}:\\s+(\\d+) kB$`, "m").exec(status)?.[1] ?? 0);
	const bytes = Math.max(kb("VmHWM"), kb("VmRSS") + kb("VmSwap")) * 1024;
	return bytes > 0 ? bytes : null;
}

/** A process's memFigure, read beside cpuMs; null where there is no /proc or no such process. */
export async function memBytes(pid: number): Promise<number | null> {
	try {
		return memFigure(await fs.readFile(`/proc/${pid}/status`, "utf8"));
	} catch {
		return null;
	}
}

/**
 * P1 (spike 33a): a blocking autosave stalls the tick loop from Factorio's "Saving to _autosaveN (blocking)." to its
 * "Saving finished", and the server doesn't catch the ticks up. This adds the stalls up between two readings.
 * ponytail: a stall counts in the sample its "Saving finished" lands in, though it may have begun in the one before;
 * one whose "Saving finished" line arrives after the next reading's RCON reply is subtracted from the following sample.
 */
export class SaveStalls {
	private since: number | undefined;
	private total = 0;

	line(message: string, now: number): void {
		if (/^Saving to _autosave\d+ \(blocking\)\.$/.test(message)) {
			this.since = now;
		} else if (message === "Saving finished" && this.since !== undefined) {
			this.total += now - this.since;
			this.since = undefined;
		}
	}

	/** The stalls since the last take(). */
	take(): number {
		const total = this.total;
		this.total = 0;
		return total;
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

	/** The mean CPU ms per tick of the samples that have one, within 60 s of the newest sample held (ruling C15). */
	meanMs(instanceId: number): number | undefined {
		const recent = this.recent(instanceId);
		const since = (recent.at(-1)?.at ?? 0) - 60_000;
		const ms = recent.flatMap(s => (s.at > since && s.ms !== null ? [s.ms] : []));
		return ms.length > 0 ? ms.reduce((a, b) => a + b, 0) / ms.length : undefined;
	}

	/** The mean UPS and CPU ms per tick of the samples that ended in (from, to]; undefined when none did (§5.6). */
	mean(instanceId: number, from: number, to: number): { ups: number; ms: number | null } | undefined {
		const window = this.recent(instanceId).filter(s => s.at > from && s.at <= to);
		if (window.length === 0) {
			return undefined;
		}
		const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
		const ms = window.flatMap(s => (s.ms === null ? [] : [s.ms]));
		return { ups: avg(window.map(s => s.ups)), ms: ms.length > 0 ? avg(ms) : null };
	}

	/**
	 * §5.5, R14: every sample of the last `lagMs` (back from the newest held) is under `floor`, and enough of them
	 * cover it. M1: `lagMs` is clamped to what is kept less one report's span, so a longer window still fires.
	 */
	lagging(instanceId: number, floor: number, lagMs: number): boolean {
		lagMs = Math.min(lagMs, KEEP_MS - REPORT_EVERY * SAMPLE_MS);
		const recent = this.recent(instanceId);
		const since = (recent.at(-1)?.at ?? 0) - lagMs;
		const window = recent.filter(s => s.at > since);
		return window.length >= lagMs / SAMPLE_MS - 1 && window.every(s => s.ups < floor);
	}

	/** Drop an instance's samples (a move ended). */
	forget(id: number): void {
		this.samples.delete(id);
	}

	private recent(instanceId: number): Sample[] {
		const since = this.now() - KEEP_MS;
		return (this.samples.get(instanceId) ?? []).filter(s => s.at > since);
	}
}
