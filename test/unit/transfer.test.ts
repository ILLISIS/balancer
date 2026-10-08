import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { receive } from "../../transfer.js";

test("receive writes a source that ends to the file, through a temporary file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "balancer-receive-"));
	const file = join(dir, "7.zip");
	const source = new PassThrough();
	const done = receive(source, file);
	source.end(Buffer.from("PK new save"));
	await done;
	assert.equal(await readFile(file, "utf8"), "PK new save");
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
