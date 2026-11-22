import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lib from "@clusterio/lib";
import type { Host } from "@clusterio/host";
import { benchmark, factorioInstall, modsDir, parseAvg } from "../../preflight.js";

const dirs: string[] = [];
const temp = async () => {
	const dir = await mkdtemp(join(tmpdir(), "balancer-preflight-"));
	dirs.push(dir);
	return dir;
};
after(() => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))));

/** A fake install of `v` in `dir/v`, with the changelog.txt Clusterio reads the version from. */
const install = async (dir: string, v: string) => {
	await mkdir(join(dir, v, "data"), { recursive: true });
	await writeFile(join(dir, v, "data", "changelog.txt"), `---\nVersion: ${v}\nDate: 2026\n`);
};

test("parseAvg reads Factorio's benchmark summary line", () => {
	const out = "  Performed 1800 updates in 788.731 ms\n  avg: 0.438 ms, min: 0.202 ms, max: 1.910 ms\n";
	assert.equal(parseAvg(out), 0.438);
	assert.equal(parseAvg("Goodbye\n"), undefined);
});

test("factorioInstall finds a version in a folder of versions, the latest, or a direct install", async () => {
	const dir = await temp();
	for (const v of ["2.1.20", "2.1.21"]) {
		await install(dir, v);
	}
	assert.deepEqual(await factorioInstall(dir, "2.1.20"), {
		data: join(dir, "2.1.20", "data"), bin: join(dir, "2.1.20", "bin", "x64", "factorio"), version: "2.1.20",
	});
	assert.equal((await factorioInstall(dir, "latest")).data, join(dir, "2.1.21", "data"));
	assert.equal((await factorioInstall(join(dir, "2.1.21"), "latest")).data, join(dir, "2.1.21", "data"));
	await assert.rejects(factorioInstall(dir, "1.1.110"), /1\.1\.110/);
});

test("factorioInstall resolves X.Y as Clusterio does, and a direct install must match", async () => {
	const dir = await temp();
	for (const v of ["2.0.9", "2.0.72", "2.1.21"]) {
		await install(dir, v);
	}
	assert.equal((await factorioInstall(dir, "2.0")).version, "2.0.72");
	assert.equal((await factorioInstall(join(dir, "2.1.21"), "2.1")).version, "2.1.21");
	await assert.rejects(factorioInstall(join(dir, "2.1.21"), "2.0"), /2\.0/);
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
