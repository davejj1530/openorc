/** Online cold-start + offline cache reuse, using only synthetic text and a disposable cache.
 * Run: pnpm exec tsx scripts/memory-embedding-smoke.mts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Embedder } from "../packages/memory/src/embedder.js";

const script = fileURLToPath(import.meta.url);
const cachedDir = process.env.OPENORC_EMBEDDING_SMOKE_CACHE;
const texts = ["The cat is sleeping on the sofa.", "A database migration adds an index."];

function checkVector(vector: Float32Array) {
  assert.equal(vector.length, 384);
  assert.ok(vector.every(Number.isFinite));
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 0.01, `Expected normalized embedding, got ${norm}`);
}

async function verify(cache: string) {
  const embedder = new Embedder(cache);
  assert.equal(await embedder.ready(), true, "MiniLM initializes");
  const vectors = await embedder.embed(texts);
  assert.ok(vectors);
  assert.equal(vectors.length, texts.length);
  vectors.forEach(checkVector);
  const query = await embedder.embedQuery(texts[0]!);
  assert.ok(query);
  checkVector(query);
  const score = (vector: Float32Array) => vector.reduce((sum, value, i) => sum + value * query[i]!, 0);
  assert.ok(score(vectors[0]!) > score(vectors[1]!), "Matching text ranks above unrelated text");
  assert.deepEqual(await embedder.embed([]), []);
  const repeated = await embedder.embed([texts[0]!]);
  assert.ok(repeated?.[0]);
  assert.ok(repeated[0].every((value, i) => Math.abs(value - vectors[0]![i]!) < 0.00001));
}

if (cachedDir) {
  assert.ok(path.basename(cachedDir).startsWith("openorc-embedding-smoke-"));
  // FastEmbed's GCS loader uses https.get. Fail if warm initialization tries a download.
  https.get = () => {
    throw new Error("Offline cache check attempted a network request");
  };
  await verify(cachedDir);
  console.log("PASS: fresh-process offline cache reuse and 384-dimensional embeddings");
} else {
  const cache = await mkdtemp(path.join(os.tmpdir(), "openorc-embedding-smoke-"));
  try {
    await verify(cache);
    console.log("PASS: cold model download, extraction, initialization, ordering, and embeddings");
    const child = spawnSync(process.execPath, ["--import", "tsx", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, OPENORC_EMBEDDING_SMOKE_CACHE: cache },
      stdio: "inherit",
      timeout: 60_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, "Offline cache check succeeds in a new process");
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}
