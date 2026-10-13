import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as lib from "@clusterio/lib";
import type { Host } from "@clusterio/host";
import { benchmark, factorioInstall, joinBenchmark, modsDir, parseAvg, type Bench } from "../../preflight.js";

const dirs: string[] = [];
const temp = async () => {
	const dir = await mkdtemp(join(tmpdir(), "balancer-preflight-"));
	dirs.push(dir);
	return dir;
};
after(() => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))));

test("parseAvg reads Factorio's benchmark summary line", () => {
	const out = "  Performed 1800 updates in 788.731 ms\n  avg: 0.438 ms, min: 0.202 ms, max: 1.910 ms\n";
	assert.equal(parseAvg(out), 0.438);
	assert.equal(parseAvg("Goodbye\n"), undefined);
});

test("factorioInstall finds a version in a folder of versions, the latest, or a direct install", async () => {
	const dir = await temp();
	for (const v of ["2.1.20", "2.1.21"]) {
		await mkdir(join(dir, v, "data", "base"), { recursive: true });
		await writeFile(join(dir, v, "data", "base", "info.json"), JSON.stringify({ version: v }));
	}
	assert.deepEqual(await factorioInstall(dir, "2.1.20"), {
		data: join(dir, "2.1.20", "data"), bin: join(dir, "2.1.20", "bin", "x64", "factorio"), version: "2.1.20",
	});
	assert.equal((await factorioInstall(dir, "latest")).data, join(dir, "2.1.21", "data"));
	assert.equal((await factorioInstall(join(dir, "2.1.21"), "latest")).data, join(dir, "2.1.21", "data"));
	await assert.rejects(factorioInstall(dir, "1.1.110"), /no Factorio 1\.1\.110/);
});

test("modsDir links the pack's mods and writes its mod-list.json and mod-settings.dat", async () => {
	const dir = await temp();
	const hostMods = join(dir, "host-mods");
	await mkdir(hostMods);
	await writeFile(join(hostMods, "universal_edges_2.1.0.zip"), "zip");
	const pack = new lib.ModPack();
	pack.name = "v2-dev";
	pack.factorioVersion = "2.1.21";
	pack.mods.set("universal_edges", { name: "universal_edges", enabled: true, version: "2.1.0" } as lib.ModRecord);
	const host = {
		config: { get: (field: string) => (field === "host.mods_directory" ? hostMods : undefined) },
		fetchMods: async () => [{ filename: "universal_edges_2.1.0.zip" }],
	} as unknown as Host;
	await modsDir(host, pack, join(dir, "mods"));
	const link = join(dir, "mods", "universal_edges_2.1.0.zip");
	assert.equal(await readlink(link), join(hostMods, "universal_edges_2.1.0.zip"));
	const listText = await readFile(join(dir, "mods", "mod-list.json"), "utf8");
	const list = JSON.parse(listText) as { mods: { name: string }[] };
	assert.deepEqual(list.mods.map(m => m.name), ["universal_edges"]);
	assert.ok((await readFile(join(dir, "mods", "mod-settings.dat"))).length > 0);
});

/** A stand-in Factorio: a shell script that runs `body`. */
async function fakeFactorio(dir: string, body: string): Promise<string> {
	const bin = join(dir, "factorio");
	await writeFile(bin, `#!/bin/sh\n${body}\n`);
	await chmod(bin, 0o755); // written fully before it is made executable and spawned (ETXTBSY)
	return bin;
}

test("benchmark runs Factorio on its own config.ini and the mods dir, and returns the avg ms per tick", async () => {
	const dir = await temp();
	const bin = await fakeFactorio(dir, [
		`echo "$@" > "${dir}/args"`,
		"echo '  Performed 1800 updates in 788.731 ms'",
		"echo '  avg: 0.438 ms, min: 0.202 ms, max: 1.910 ms'",
	].join("\n"));
	const mods = join(dir, "mods");
	const save = join(dir, "save.zip");
	assert.equal(await benchmark({ bin, data: "/f/data", mods, save, ticks: 1800, dir }), 0.438);
	const args = (await readFile(join(dir, "args"), "utf8")).trim();
	assert.equal(args,
		`-c ${join(dir, "config.ini")} --mod-directory ${mods} --benchmark ${save} --benchmark-ticks 1800`);
	const ini = await readFile(join(dir, "config.ini"), "utf8");
	assert.equal(ini, `[path]\nread-data=/f/data\nwrite-data=${join(dir, "write")}\n`);
});

test("a benchmark that exits non-zero, or prints no avg line, rejects with Factorio's error lines", async () => {
	const dir = await temp();
	const failing = await fakeFactorio(dir, "echo '   1.2 Error Util.cpp:83: Failed to load mods'\nexit 1");
	const b = { bin: failing, data: "/d", mods: "/m", save: "/s.zip", ticks: 1800, dir };
	await assert.rejects(benchmark(b), /exited 1: .*Failed to load mods/);
	const silent = await fakeFactorio(dir, "echo Goodbye");
	await assert.rejects(benchmark({ ...b, bin: silent }), /exited 0 with no avg line/);
});

test("the join benchmark (§5.7, R6): a probe sets the ticks; copies up to the cores; slots within 1.25×", async () => {
	const dir = await temp();
	const runs: Bench[] = [];
	// One copy's ms per tick at each count, as a multiple of a single copy's 0.5 ms.
	const slower: Record<string, number> = { probe: 1, 1: 1, 2: 1.2, 4: 1.3, 8: 2 };
	const run = async (b: Bench) => {
		runs.push(b);
		return 0.5 * slower[basename(b.dir).split("-")[0]];
	};
	const b = { bin: "/f", data: "/d", mods: "/m", save: "/s.zip" };
	assert.deepEqual(await joinBenchmark(b, dir, 32, run), {
		speed: 0.5,
		slots: 2,
		runs: [{ copies: 1, msPerTick: 0.5 }, { copies: 2, msPerTick: 0.6 }, { copies: 4, msPerTick: 0.65 }],
	});
	assert.deepEqual(runs.map(r => r.ticks), [1800, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000],
		"30 s at 0.5 ms; 4 is beyond 1.25×, so 8 never runs");
	assert.equal(new Set(runs.map(r => r.dir)).size, 8, "each copy in its own folder");
	runs.length = 0;
	assert.equal((await joinBenchmark(b, dir, 3, run)).slots, 2);
	assert.deepEqual(
		runs.map(r => basename(r.dir)), ["probe", "1-0", "2-0", "2-1"], "stops at max: the cores, or fewer by memory",
	);
});

test("memory §3.4 (M7): the join benchmark runs only the counts that fit; none throws before the probe", async () => {
	const dir = await temp();
	const runs: string[] = [];
	const run = async (b: Bench) => {
		runs.push(basename(b.dir));
		return 0.5;
	};
	const b = { bin: "/f", data: "/d", mods: "/m", save: "/s.zip" };
	assert.equal((await joinBenchmark(b, dir, 2, run)).slots, 2);
	assert.deepEqual(runs, ["probe", "1-0", "2-0", "2-1"], "maxCopies 2: 1 and 2 copies only");
	runs.length = 0;
	await assert.rejects(joinBenchmark(b, dir, 0, run), /no memory room for one copy/);
	assert.deepEqual(runs, [], "nothing ran, not even the probe");
});

test("a failing copy doesn't end the join benchmark until its siblings have finished", async () => {
	const dir = await temp();
	let live = 0;
	const run = async (b: Bench) => {
		if (basename(b.dir) === "probe") {
			return 0.5;
		}
		live += 1;
		await new Promise(resolve => setTimeout(resolve, basename(b.dir).endsWith("-0") ? 0 : 20));
		live -= 1;
		if (basename(b.dir) === "2-0") {
			throw new Error("boom");
		}
		return 0.5;
	};
	await assert.rejects(joinBenchmark({ bin: "/f", data: "/d", mods: "/m", save: "/s.zip" }, dir, 4, run), /boom/);
	assert.equal(live, 0, "no copy is still running when it rejects");
});
