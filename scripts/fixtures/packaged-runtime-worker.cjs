// Runs in the packaged app's own Electron utility process, using its dependencies.
const assert = require("node:assert/strict");
const { createRequire, syncBuiltinESMExports } = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function verify() {
  const [resources, cache] = process.argv.slice(2);
  assert.ok(process.versions.electron, "Must run inside Electron");
  const packagedRequire = createRequire(path.join(resources, "app.asar/package.json"));
  const entry = packagedRequire.resolve("fastembed");
  assert.ok(entry.startsWith(path.join(resources, "app.asar") + path.sep), "Use the packaged dependency, never workspace node_modules");
  let requests = 0;
  const deny = () => {
    requests += 1;
    throw new Error("Offline model check attempted network access");
  };
  for (const name of ["node:http", "node:https"]) {
    const client = require(name);
    client.get = deny;
    client.request = deny;
  }
  globalThis.fetch = deny;
  syncBuiltinESMExports();
  // Match the ESM export the embedder worker uses, not just FastEmbed's CJS branch.
  const { FlagEmbedding, EmbeddingModel } = await import(pathToFileURL(path.resolve(entry, "../../esm/index.js")).href);
  const model = await FlagEmbedding.init({ model: EmbeddingModel.AllMiniLML6V2, cacheDir: cache, showDownloadProgress: false });
  const texts = ["The cat is sleeping on the sofa.", "A database migration adds an index."];
  const vectors = [];
  for await (const batch of model.embed(texts)) vectors.push(...batch);
  assert.equal(vectors.length, 2);
  for (const vector of vectors) {
    assert.equal(vector.length, 384);
    assert.ok(vector.every(Number.isFinite));
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(norm - 1) < 0.01, "Embedding is normalized");
  }
  const query = await model.queryEmbed(texts[0]);
  const score = (vector) => vector.reduce((sum, value, index) => sum + value * query[index], 0);
  assert.ok(score(vectors[0]) > score(vectors[1]), "Matching text ranks above unrelated text");
  assert.equal(requests, 0);
  process.parentPort.postMessage({ ok: true, dimensions: 384 });
}
verify().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
