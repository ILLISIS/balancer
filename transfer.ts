import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as lib from "@clusterio/lib";
import type { ControllerPluginContext } from "@clusterio/controller";
import type { ProxyStream } from "@clusterio/controller/dist/node/src/routes.js";

type Controller = ControllerPluginContext["controller"];

/**
 * A proxy stream as routes.ts:326-345 creates one;
 * createProxyStream isn't exported, so this mirrors it (plan ruling 9).
 * `/api/stream/<id>` serves its source to one GET, or takes a host's PUT as its source. It closes after
 * controller.proxy_stream_timeout unless both ends attach. With `file`, the source is that file, read once.
 * ponytail: follows Clusterio's shape at the pin; check routes.ts on a repin.
 */
export function proxyStream(controller: Controller, file?: { path: string; size: number }): ProxyStream {
	const id = randomBytes(8).toString("hex");
	const stream: ProxyStream = {
		id,
		source: file ? createReadStream(file.path) : null,
		flowing: false,
		size: file ? String(file.size) : undefined,
		mime: file ? "application/zip" : undefined,
		filename: null,
		events: new EventEmitter() as ProxyStream["events"],
		timeout: setTimeout(() => {
			stream.events.emit("timeout");
		}, controller.config.get("controller.proxy_stream_timeout") * 1000),
	};
	stream.events.on("close", () => {
		clearTimeout(stream.timeout);
		controller.app.locals.streams.delete(id);
		if (file) {
			stream.source?.destroy();
		}
	});
	stream.events.on("timeout", () => {
		stream.events.emit("close");
	});
	controller.app.locals.streams.set(id, stream);
	return stream;
}

/** Rejects unless the file's tail holds a zip End-Of-Central-Directory record: a short upload isn't a save. */
async function requireZip(tmp: string, file: string): Promise<void> {
	const fh = await fs.open(tmp, "r");
	try {
		const { size } = await fh.stat();
		const len = Math.min(size, 65557); // the EOCD record (22 bytes) plus a comment of up to 65535
		const { buffer } = await fh.read(Buffer.alloc(len), 0, len, size - len);
		if (!buffer.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))) {
			throw new Error(`incomplete save: ${path.basename(file)}`);
		}
	} finally {
		await fh.close();
	}
}

/**
 * Writes `source` to `file` through a temporary file, renamed only once the source has ended. A source destroyed first
 * rejects and leaves `file` as it was: Node's 300 s requestTimeout cuts a slow host's upload that way (spike 32).
 */
export async function receive(source: Readable, file: string): Promise<void> {
	const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
	await fs.mkdir(path.dirname(file), { recursive: true });
	const fh = await fs.open(tmp, "w");
	try {
		await pipeline(source, fh.createWriteStream());
		await requireZip(tmp, file);
		await fs.rename(tmp, file);
	} catch (err) {
		await fs.rm(tmp, { force: true }); // after the pipeline has settled, so the write stream can't recreate tmp
		throw err;
	}
}

/**
 * The save `name` of an instance into `file`, from its assigned host (InstancePushSaveRequest: the host PUTs it into a
 * proxy stream). The stream is consumed in-process, so a cut upload rejects instead of hanging (spike 32).
 */
export async function pull(controller: Controller, instanceId: number, name: string, file: string): Promise<void> {
	const stream = proxyStream(controller);
	try {
		const source = new Promise<Readable>((resolve, reject) => {
			stream.events.on("source", () => resolve(stream.source!));
			stream.events.on("timeout", () => reject(new Error("the host never started its upload")));
		});
		source.catch(() => undefined); // awaited below; this only keeps an early failure from going unhandled
		await controller.sendToHostByInstanceId(new lib.InstancePushSaveRequest(instanceId, stream.id, name));
		const readable = await source;
		stream.flowing = true;
		clearTimeout(stream.timeout);
		await receive(readable, file);
	} finally {
		stream.events.emit("close");
	}
}

/**
 * `file` into the instance's saves on its assigned host as `name` (InstancePullSaveRequest: the host GETs it). Returns
 * the name the host stored it under: a taken name becomes name-2.zip and so on (Host.ts:1077-1089).
 */
export async function push(controller: Controller, instanceId: number, file: string, name: string): Promise<string> {
	const { size } = await fs.stat(file);
	const stream = proxyStream(controller, { path: file, size });
	try {
		return await controller.sendToHostByInstanceId(new lib.InstancePullSaveRequest(instanceId, stream.id, name));
	} finally {
		stream.events.emit("close");
	}
}
