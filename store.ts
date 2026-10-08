import * as path from "node:path";
import type * as lib from "@clusterio/lib";
import type { Copy, State } from "./state.js";

/** What the store needs: a pull of one save into a file, persistence, a log line and the clock. */
export type StorePort = {
	pull(instanceId: number, name: string, file: string): Promise<void>;
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
 * At most `max` of these pulls run at once. The pulls
 * of one instance run one after another, so the last one asked for is the copy. A failed pull keeps the previous copy
 * and logs a warning.
 * ponytail: mtimes are the hosts' clocks, and a pull with no mtime (the mover's) is stamped with the controller's.
 * A host clock far behind skips its next autosaves until it catches up.
 */
export class SaveStore {
	private waiting = new Map<number, lib.SaveDetails>();
	private running = 0;
	private chains = new Map<number, Promise<void>>();

	constructor(private state: State, private dir: string, private port: StorePort, private max = 3) { }

	file(instanceId: number): string {
		return path.join(this.dir, `${instanceId}.zip`);
	}

	copy(instanceId: number): Copy | undefined {
		return this.state.copies[instanceId];
	}

	/** controller.saves' "update", and the saves listed at start: queue each newer one, then pump. */
	updated(saves: lib.SaveDetails[]): void {
		for (const s of saves.filter(copyable)) {
			const have = Math.max(this.copy(s.instanceId)?.mtimeMs ?? 0, this.waiting.get(s.instanceId)?.mtimeMs ?? 0);
			if (s.mtimeMs > have) {
				this.waiting.set(s.instanceId, s);
			}
		}
		this.pump();
	}

	/** Pull `name` now, after any pull of this instance in flight (the mover's step 3); rejects when it fails. */
	pull(instanceId: number, name: string, mtimeMs = this.port.now(), size = 0): Promise<void> {
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
			if (this.running >= this.max) {
				return;
			}
			this.waiting.delete(instanceId);
			this.running += 1;
			this.pull(instanceId, s.name, s.mtimeMs, s.size).catch((err: Error) => {
				this.port.log("pull_failed", { instance: instanceId, save: s.name, error: err.message }, "warn");
			}).finally(() => {
				this.running -= 1;
				this.pump();
			});
		}
	}
}
