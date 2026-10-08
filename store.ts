import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as lib from "@clusterio/lib";
import type { Copy, State } from "./state.js";

/** What the store needs: a pull of one save into a file, an instance's host, persistence, a log line and the clock. */
export type StorePort = {
	pull(instanceId: number, name: string, file: string): Promise<void>;
	/** The instance's assigned host, which uploads its saves (P2). */
	host(instanceId: number): number | null;
	save(): Promise<void>;
	log(phase: string, fields: Record<string, unknown>, level?: "info" | "warn"): void;
	now(): number;
};

/** A save worth copying: a file, not deleted, not Clusterio's partial *.tmp.zip. */
export function copyable(s: lib.SaveDetails): boolean {
	return s.type === "file" && !s.isDeleted && !s.name.endsWith(".tmp.zip");
}

/**
 * The save store (§4.3 unit 1, §5.1). Each instance's newest copyable save is pulled to <dir>/<id>.zip once it is newer
 * than the copy (any file save, not only autosaves: plan ruling 17).
 * Each host uploads one of these at a time, with no cluster-wide cap (P2, spike 33b: a host's uplink is the
 * bottleneck, and a slow one's 300 s attempts mustn't hold the others up); the mover's own pulls don't wait. The pulls
 * of one instance run one after another, so the last one asked for is the copy. A failed pull keeps the previous copy
 * and logs a warning.
 * ponytail: mtimes are the hosts' clocks, and a pull with no mtime (the mover's) is stamped with the controller's.
 * A host clock far behind skips its next autosaves until it catches up.
 */
export class SaveStore {
	private waiting = new Map<number, lib.SaveDetails>();
	/** Hosts uploading a queued save now (P2). */
	private uploading = new Set<number | null>();
	private inflight = new Map<number, number>();
	private chains = new Map<number, Promise<void>>();

	constructor(private state: State, private dir: string, private port: StorePort) { }

	file(instanceId: number): string {
		return path.join(this.dir, `${instanceId}.zip`);
	}

	copy(instanceId: number): Copy | undefined {
		return this.state.copies[instanceId];
	}

	/** controller.saves' "update", and the saves listed at start: queue each newer one, then pump. */
	updated(saves: lib.SaveDetails[]): void {
		for (const s of saves.filter(x => x.isDeleted)) {
			// C48: Clusterio deletes an instance's saves on reassign; a queued one would be pulled from the new host.
			if (this.waiting.get(s.instanceId)?.name === s.name) {
				this.waiting.delete(s.instanceId);
			}
		}
		for (const s of saves.filter(copyable)) {
			const have = Math.max(
				this.copy(s.instanceId)?.mtimeMs ?? 0,
				this.waiting.get(s.instanceId)?.mtimeMs ?? 0,
				this.inflight.get(s.instanceId) ?? 0,
			);
			if (s.mtimeMs > have) {
				this.waiting.set(s.instanceId, s);
			}
		}
		this.pump();
	}

	/** C49: the instance has a new host; hosts' clocks differ, so its next save there is pulled whatever its mtime. */
	hostChanged(instanceId: number): void {
		if (this.state.copies[instanceId]) {
			this.state.copies[instanceId].mtimeMs = 0;
		}
	}

	/** C45: the instance was deleted; its copy goes with it. ponytail: a pull in flight can still write the file. */
	async drop(instanceId: number): Promise<void> {
		delete this.state.copies[instanceId];
		this.waiting.delete(instanceId);
		await fs.rm(this.file(instanceId), { force: true });
		await this.port.save();
	}

	/** Pull `name` now, after any pull of this instance in flight (the mover's step 3); rejects when it fails. */
	pull(instanceId: number, name: string, mtimeMs = this.port.now(), size = 0): Promise<void> {
		// Nothing newer than a direct pull's save can exist, so an older queued one is stale (the pump's own: no-op).
		this.waiting.delete(instanceId);
		const run = async () => {
			await this.port.pull(instanceId, name, this.file(instanceId));
			this.state.copies[instanceId] = { name, mtimeMs, size, pulledAt: this.port.now() };
			await this.port.save();
			this.port.log("pulled", { instance: instanceId, save: name });
		};
		const next = (this.chains.get(instanceId) ?? Promise.resolve()).catch(() => undefined).then(run);
		this.chains.set(instanceId, next);
		return next;
	}

	private pump(): void {
		for (const [instanceId, s] of this.waiting) {
			const host = this.port.host(instanceId);
			if (this.uploading.has(host)) {
				continue;
			}
			this.waiting.delete(instanceId);
			this.uploading.add(host);
			this.inflight.set(instanceId, s.mtimeMs);
			this.pull(instanceId, s.name, s.mtimeMs, s.size).finally(() => {
				this.inflight.delete(instanceId);
			}).catch((err: Error) => {
				this.port.log("pull_failed", { instance: instanceId, save: s.name, error: err.message }, "warn");
			}).finally(() => {
				this.uploading.delete(host);
				this.pump();
			});
		}
	}
}
