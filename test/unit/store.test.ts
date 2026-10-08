import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type * as lib from "@clusterio/lib";
import { emptyState } from "../../state.js";
import { SaveStore } from "../../store.js";
import { settle } from "./helpers.js";

type Pending = { id: number; name: string; resolve(): void; reject(err: Error): void };
type Line = { phase: string; fields: Record<string, unknown>; level?: string };

/** A store whose pulls wait until the test resolves or rejects them. */
function fakeStore(max = 3) {
	const state = emptyState();
	const pulls: Pending[] = [];
	const lines: Line[] = [];
	const store = new SaveStore(state, "/store", {
		pull: (id, name) => new Promise<void>((resolve, reject) => {
			pulls.push({ id, name, resolve, reject });
		}),
		save: async () => undefined,
		log: (phase, fields, level) => {
			lines.push({ phase, fields, level });
		},
		now: () => 5000,
	}, max);
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

test("at most 3 pulls run at once (§4.3); the next starts when one ends", async () => {
	const { store, pulls } = fakeStore();
	store.updated([1, 2, 3, 4].map(id => save(id, "a.zip", 10)));
	await settle();
	assert.deepEqual(pulls.map(p => p.id), [1, 2, 3]);
	pulls[0].resolve();
	await settle();
	assert.deepEqual(pulls.map(p => p.id), [1, 2, 3, 4]);
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
