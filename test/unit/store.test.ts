import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type * as lib from "@clusterio/lib";
import { emptyState } from "../../state.js";
import { SaveStore } from "../../store.js";
import { settle } from "./helpers.js";

type Pending = { id: number; name: string; resolve(): void; reject(err: Error): void };
type Line = { phase: string; fields: Record<string, unknown>; level?: string };

/** A store whose pulls wait until the test settles them. Instances are on host 1 unless `hostOf` says. */
function fakeStore(hostOf: (instanceId: number) => number | null = () => 1) {
	const state = emptyState();
	const pulls: Pending[] = [];
	const lines: Line[] = [];
	const store = new SaveStore(state, "/store", {
		pull: (id, name) => new Promise<void>((resolve, reject) => {
			pulls.push({ id, name, resolve, reject });
		}),
		host: hostOf,
		save: async () => undefined,
		log: (phase, fields, level) => {
			lines.push({ phase, fields, level });
		},
		now: () => 5000,
	});
	return { state, store, pulls, lines };
}

const save = (instanceId: number, name: string, mtimeMs: number, extra: Partial<lib.SaveDetails> = {}) => ({
	instanceId, type: "file", name, size: 100, mtimeMs, loaded: false, loadByDefault: false, updatedAtMs: 0,
	isDeleted: false, ...extra,
}) as unknown as lib.SaveDetails;

test("each instance's newest copyable save is pulled once it is newer than the copy (§5.1)", async () => {
	const { state, store, pulls, lines } = fakeStore();
	store.updated([
		save(7, "_autosave1.zip", 100), save(7, "_autosave2.zip", 200), save(7, "x.tmp.zip", 300),
		save(8, "gone.zip", 50, { isDeleted: true }), save(9, "dir", 50, { type: "directory" }),
	]);
	await settle(); // a pull starts on a later turn: pulls of one instance chain on a promise
	assert.deepEqual(pulls.map(p => [p.id, p.name]), [[7, "_autosave2.zip"]]);
	pulls[0].resolve();
	await settle();
	assert.deepEqual(state.copies[7], { name: "_autosave2.zip", mtimeMs: 200, size: 100, pulledAt: 5000 });
	assert.equal(store.file(7), join("/store", "7.zip"));
	store.updated([save(7, "_autosave2.zip", 200), save(7, "_autosave1.zip", 150)]);
	await settle();
	assert.equal(pulls.length, 1, "nothing newer than the copy");
	assert.deepEqual(lines.map(l => l.phase), ["pulled"]);
});

test("each host uploads one queued save at a time; other hosts' run alongside (P2, Review Focus 4)", async () => {
	const { store, pulls } = fakeStore(id => (id < 3 ? 1 : 2));
	store.updated([1, 2, 3].map(id => save(id, "a.zip", 10)));
	await settle();
	assert.deepEqual(pulls.map(p => p.id), [1, 3], "one from host 1, one from host 2");
	pulls[0].resolve();
	await settle();
	assert.deepEqual(pulls.map(p => p.id), [1, 3, 2]);
});

test("the mover's own pull doesn't wait for its host's queued upload (P2)", async () => {
	const { store, pulls } = fakeStore();
	store.updated([save(8, "a.zip", 10)]);
	await settle();
	void store.pull(7, "stopped.zip");
	await settle();
	assert.deepEqual(pulls.map(p => p.name), ["a.zip", "stopped.zip"]);
});

test("a failed pull keeps the previous copy and logs a warning (§5.1)", async () => {
	const { state, store, pulls, lines } = fakeStore();
	const old = { name: "old.zip", mtimeMs: 10, size: 1, pulledAt: 1 };
	state.copies[7] = old;
	store.updated([save(7, "new.zip", 20)]);
	await settle();
	pulls[0].reject(new Error("aborted"));
	await settle();
	assert.deepEqual(state.copies[7], old);
	assert.deepEqual(lines, [
		{ phase: "pull_failed", fields: { instance: 7, save: "new.zip", error: "aborted" }, level: "warn" },
	]);
});

test("pulls of one instance run in order: the mover's pull after a queued one ends as the copy", async () => {
	const { state, store, pulls } = fakeStore();
	store.updated([save(7, "_autosave1.zip", 100)]);
	const moved = store.pull(7, "world.zip");
	await settle();
	assert.equal(pulls.length, 1, "the mover's pull waits for the one in flight");
	pulls[0].resolve();
	await settle();
	assert.deepEqual(pulls.map(p => p.name), ["_autosave1.zip", "world.zip"]);
	pulls[1].resolve();
	await moved;
	assert.equal(state.copies[7].name, "world.zip");
	assert.equal(state.copies[7].mtimeMs, 5000, "a pull with no mtime is stamped now");
});

test("a save being pulled is not queued again by a repeat listing", async () => {
	const { store, pulls } = fakeStore();
	store.updated([save(7, "a.zip", 100)]);
	await settle();
	store.updated([save(7, "a.zip", 100)]);
	pulls[0].resolve();
	await settle();
	assert.equal(pulls.length, 1);
});

test("a direct pull drops the older save queued for the same instance (C24)", async () => {
	const { store, pulls } = fakeStore();
	store.updated([save(8, "a.zip", 100), save(7, "_autosave1.zip", 100)]);
	await settle();
	assert.deepEqual(pulls.map(p => p.id), [8]);
	void store.pull(7, "stopped.zip");
	await settle();
	pulls[1].resolve();
	pulls[0].resolve();
	await settle();
	assert.deepEqual(pulls.map(p => p.name), ["a.zip", "stopped.zip"]);
});

test("a direct pull drops the older queued save at once, though that instance is pulling (C24a)", async () => {
	const { state, store, pulls } = fakeStore(id => id);
	store.updated([save(7, "A1.zip", 100), save(8, "b.zip", 100)]);
	await settle();
	store.updated([save(7, "A2.zip", 200)]);
	void store.pull(7, "stopped.zip");
	pulls[1].resolve(); // b ends first: the pump must find nothing queued for 7
	await settle();
	pulls[0].resolve();
	await settle();
	pulls[2]?.resolve();
	await settle();
	assert.deepEqual(pulls.map(p => p.name), ["A1.zip", "b.zip", "stopped.zip"]);
	assert.equal(state.copies[7].name, "stopped.zip");
});

test("a pump pull behind an earlier one keeps a newer queued save (C24b)", async () => {
	const { state, store, pulls } = fakeStore();
	store.updated([save(7, "A0.zip", 100)]);
	await settle();
	store.updated([save(7, "A1.zip", 200)]);
	store.updated([save(7, "A2.zip", 300)]);
	for (let i = 0; i < 5; i++) {
		pulls[i]?.resolve();
		await settle();
	}
	assert.equal(state.copies[7].name, "A2.zip");
});

test("a deleted save drops the queued entry of the same name (C48)", async () => {
	const { store, pulls } = fakeStore();
	store.updated([save(8, "a.zip", 100), save(7, "A.zip", 100)]);
	await settle();
	store.updated([save(7, "A.zip", 100, { isDeleted: true })]);
	pulls[0].resolve();
	await settle();
	assert.deepEqual(pulls.map(p => p.name), ["a.zip"]);
});

test("a changed host zeroes the copy's mtime, so the next save there is pulled (C49)", async () => {
	const { state, store, pulls } = fakeStore();
	state.copies[7] = { name: "old.zip", mtimeMs: 9_000, size: 1, pulledAt: 1 };
	store.updated([save(7, "new.zip", 500)]);
	await settle();
	assert.equal(pulls.length, 0, "older by the clocks");
	store.hostChanged(7);
	store.updated([save(7, "new.zip", 500)]);
	await settle();
	assert.deepEqual(pulls.map(p => p.name), ["new.zip"]);
});

test("drop removes the copy and its queued save (C45)", async () => {
	const { state, store } = fakeStore();
	state.copies[7] = { name: "old.zip", mtimeMs: 1, size: 1, pulledAt: 1 };
	await store.drop(7);
	assert.equal(store.copy(7), undefined);
});
