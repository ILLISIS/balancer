import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as lib from "@clusterio/lib";
import type { Host } from "@clusterio/host";

/** Factorio's benchmark summary: "avg: 0.438 ms, min: …" (spike 32). */
export function parseAvg(output: string): number | undefined {
	const m = /avg: (\d+(?:\.\d+)?) ms/.exec(output);
	return m ? Number(m[1]) : undefined;
}

/**
 * The Factorio install for `version` under a host's factorio_directory, and its version: a direct install, or a folder
 * of versions, as server.ts:findVersion finds them; the pin exports that only as _findVersion. ponytail: an exact
 * version or "latest", and a direct install is taken whatever its version.
 */
export async function factorioInstall(
	dir: string, version: string,
): Promise<{ data: string; bin: string; version: string }> {
	const versionOf = async (d: string) => {
		try {
			const info = JSON.parse(await fs.readFile(path.join(d, "data", "base", "info.json"), "utf8"));
			return (info as { version: string }).version;
		} catch {
			return undefined;
		}
	};
	const install = (d: string, v: string) => (
		{ data: path.join(d, "data"), bin: path.join(d, "bin", "x64", "factorio"), version: v }
	);
	const direct = await versionOf(dir);
	if (direct !== undefined) {
		return install(dir, direct);
	}
	const found: { version: string; dir: string }[] = [];
	for (const name of await fs.readdir(dir)) {
		const v = await versionOf(path.join(dir, name));
		if (v !== undefined) {
			found.push({ version: v, dir: path.join(dir, name) });
		}
	}
	found.sort((a, b) => lib.integerFullVersion(b.version as lib.FullVersion) -
		lib.integerFullVersion(a.version as lib.FullVersion));
	const pick = version === "latest" ? found[0] : found.find(f => f.version === version);
	if (!pick) {
		throw new Error(`no Factorio ${version} in ${dir}`);
	}
	return install(pick.dir, pick.version);
}

/**
 * A mods dir for `pack`, built as Instance.syncMods builds one (Instance.ts:826-885): a symlink per mod into the host's
 * mods dir (fetching any it lacks), plus the pack's mod-list.json and mod-settings.dat. ponytail: symlinks, so Linux
 * and macOS hosts; Clusterio hard-links on Windows.
 */
export async function modsDir(host: Host, pack: lib.ModPack, dir: string): Promise<void> {
	const mods = await host.fetchMods(pack.mods.values(), pack.factorioVersion);
	const from = path.resolve(host.config.get("host.mods_directory"));
	await fs.mkdir(dir, { recursive: true });
	for (const mod of mods) {
		await fs.symlink(path.join(from, mod.filename), path.join(dir, mod.filename));
	}
	await fs.writeFile(path.join(dir, "mod-list.json"), JSON.stringify({ mods: [...pack.mods.values()] }, null, "\t"));
	await fs.writeFile(path.join(dir, "mod-settings.dat"), pack.toModSettingsDat());
}

export type Bench = { bin: string; data: string; mods: string; save: string; ticks: number; dir: string };

/**
 * `factorio --benchmark` on `save` for `ticks` (§5.2 step 1), with its own config.ini and write-data in `dir`, so it
 * never takes the install's or an instance's .lock. Returns Factorio's average ms per tick.
 */
export async function benchmark(b: Bench, timeoutMs = 600_000): Promise<number> {
	const config = path.join(b.dir, "config.ini");
	const write = path.join(b.dir, "write");
	await fs.mkdir(write, { recursive: true });
	await fs.writeFile(config, `[path]\nread-data=${b.data}\nwrite-data=${write}\n`);
	const args = ["-c", config, "--mod-directory", b.mods, "--benchmark", b.save, "--benchmark-ticks", String(b.ticks)];
	const child = spawn(b.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", (chunk: Buffer) => {
		out += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		out += chunk.toString();
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	const code = await new Promise<number | null>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	}).finally(() => clearTimeout(timer));
	const avg = parseAvg(out);
	if (code !== 0 || avg === undefined) {
		const errors = out.split("\n").filter(line => /\bError\b/.test(line)).slice(0, 3).join(" | ");
		const why = `${code}${avg === undefined && code === 0 ? " with no avg line" : ""}`;
		throw new Error(`benchmark exited ${why}: ${errors || out.slice(-300).trim()}`);
	}
	return avg;
}

/** §5.7: the counts of copies run at once, stopping at the core count. */
const COPIES = [1, 2, 4, 8];
/** §5.7's "about 30 s each". */
const RUN_MS = 30_000;
/** §5.7: slots are the copies whose ms per tick stays within this of a single copy's. */
const WITHIN = 1.25;

/**
 * The join benchmark (§5.7, R6) on `b.save`, in folders under `dir`. --benchmark runs flat out (spike 32), so a
 * 1800-tick probe first sets the ticks for about 30 s. Then each count of copies runs at once, its ms per tick the
 * slowest copy's, until one is beyond 1.25× a single copy's. speed: one copy's ms per tick; slots: the last count
 * within.
 */
export async function joinBenchmark(
	b: Omit<Bench, "ticks" | "dir">, dir: string, cores: number, run: (b: Bench) => Promise<number> = benchmark,
): Promise<{ speed: number; slots: number; runs: { copies: number; msPerTick: number }[] }> {
	const probe = await run({ ...b, ticks: 1800, dir: path.join(dir, "probe") });
	// ponytail: a floor of 0.01 ms keeps an empty map's "avg: 0.000 ms" from asking for endless ticks.
	const ticks = Math.max(1800, Math.round(RUN_MS / Math.max(probe, 0.01)));
	const runs: { copies: number; msPerTick: number }[] = [];
	for (const copies of COPIES.filter(n => n <= cores)) {
		// Every copy finishes before one's failure is rethrown, so the caller's cleanup never runs under a live child.
		const settled = await Promise.allSettled(Array.from({ length: copies }, (_, i) => (
			run({ ...b, ticks, dir: path.join(dir, `${copies}-${i}`) })
		)));
		const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
		if (failed) {
			throw failed.reason;
		}
		const avgs = settled.map(r => (r as PromiseFulfilledResult<number>).value);
		const msPerTick = Math.max(...avgs);
		runs.push({ copies, msPerTick });
		if (msPerTick > runs[0].msPerTick * WITHIN) {
			break;
		}
	}
	const speed = runs[0].msPerTick;
	return { speed, slots: runs.filter(r => r.msPerTick <= speed * WITHIN).at(-1)!.copies, runs };
}
