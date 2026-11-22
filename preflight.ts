import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as lib from "@clusterio/lib";
import type { Host } from "@clusterio/host";
import { findVersion } from "@clusterio/host/dist/node/src/server.js";

/** Factorio's benchmark summary: "avg: 0.438 ms, min: …" (spike 32). */
export function parseAvg(output: string): number | undefined {
	const m = /avg: (\d+(?:\.\d+)?) ms/.exec(output);
	return m ? Number(m[1]) : undefined;
}

/**
 * The Factorio install for `version` under a host's factorio_directory, and its version: Clusterio's own findVersion,
 * so a direct install, a folder of versions, and "latest" or X.Y or X.Y.Z all resolve as they do for the instance. A
 * release channel is resolved by the caller (the controller), as Instance.fromConfig does.
 */
export async function factorioInstall(
	dir: string, version: string,
): Promise<{ data: string; bin: string; version: string }> {
	const [data, found] = await findVersion(dir, version as lib.TargetVersion);
	return { data, bin: path.join(path.dirname(data), "bin", "x64", "factorio"), version: found };
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
