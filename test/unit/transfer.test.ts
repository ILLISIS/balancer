import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { receive } from "../../transfer.js";

// A minimal valid empty zip: the 22-byte End-Of-Central-Directory record.
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);

test("receive writes a source that ends to the file, through a temporary file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "balancer-receive-"));
	const file = join(dir, "7.zip");
	const source = new PassThrough();
	const done = receive(source, file);
	source.end(ZIP);
	await done;
	assert.deepEqual(await readFile(file), ZIP);
	assert.deepEqual(await readdir(dir), ["7.zip"]);
});

test("a source destroyed before its end rejects and keeps the previous copy (Review Focus 3)", async () => {
	// Spike 32: Node's 300 s requestTimeout cuts a slow host's upload; its request closes without ending.
	const dir = await mkdtemp(join(tmpdir(), "balancer-receive-"));
	const file = join(dir, "7.zip");
	await writeFile(file, "PK old save");
	const source = new PassThrough();
	const done = receive(source, file);
	source.write(Buffer.from("PK half a"));
	source.destroy();
	await assert.rejects(done);
	assert.equal(await readFile(file, "utf8"), "PK old save");
	assert.deepEqual(await readdir(dir), ["7.zip"], "no temporary file left");
});

test("a source that ends cleanly without a zip end record is rejected and keeps the old copy (C17)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "balancer-receive-"));
	const file = join(dir, "7.zip");
	await writeFile(file, "PK old save");
	const source = new PassThrough();
	const done = receive(source, file);
	source.end(Buffer.from("PK cut short"));
	await assert.rejects(done, /incomplete save: 7\.zip/);
	assert.equal(await readFile(file, "utf8"), "PK old save");
	assert.deepEqual(await readdir(dir), ["7.zip"]);
});
