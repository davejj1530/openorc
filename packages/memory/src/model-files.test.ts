import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlagEmbedding } from "fastembed";
import { ensureModel, type ModelSource } from "./model-files.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
const name = "fast-all-MiniLM-L6-v2";
const config = '{"fixture":true}';
const served = '{\n  "model_max_length": 256,\n  "do_lower_case": true\n}';
const edited = '{\n  "model_max_length": 512,\n  "do_lower_case": true\n}';
const source: ModelSource = {
  name,
  baseUrl: "https://models.example/minilm/",
  files: {
    "config.json": { sha256: sha256(config), bytes: config.length },
    "tokenizer_config.json": { sha256: sha256(edited), bytes: served.length, edits: [['"model_max_length": 256,', '"model_max_length": 512,']] },
  },
};
const bodies: Record<string, string> = { "config.json": config, "tokenizer_config.json": served };

/** Serves each fixture file by name; `changes` swaps in another body, or an HTTP status instead of one. */
function serve(changes: Record<string, string | number> = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const file = String(input).slice(source.baseUrl.length);
    const change = changes[file];
    if (typeof change === "number") return new Response("Not Found", { status: change });
    return new Response(change ?? bodies[file]);
  });
}

async function cache() {
  const root = await mkdtemp(path.join(os.tmpdir(), "openorc-model-files-"));
  dirs.push(root);
  return path.join(root, "models");
}

describe("ensureModel", () => {
  it("downloads and checks each file, then lays the model out where fastembed reads it", async () => {
    const dir = await cache();
    const fetchModel = serve();
    await ensureModel(dir, source, fetchModel);
    expect(fetchModel.mock.calls.map(([url]) => String(url))).toEqual([`${source.baseUrl}config.json`, `${source.baseUrl}tokenizer_config.json`]);
    expect(await readdir(dir)).toEqual([name]);
    expect(await readFile(path.join(dir, name, "config.json"), "utf8")).toBe(config);
    // fastembed takes the folder as its model and moves on to the tokenizer instead of downloading anything.
    await expect(FlagEmbedding.init({ model: name as never, cacheDir: dir, showDownloadProgress: false })).rejects.toThrow("Tokenizer file not found");
    await ensureModel(dir, source, fetchModel);
    expect(fetchModel).toHaveBeenCalledTimes(2);
  });

  it("makes a file's edits before checking it against its pin", async () => {
    const dir = await cache();
    await ensureModel(dir, source, serve());
    expect(await readFile(path.join(dir, name, "tokenizer_config.json"), "utf8")).toBe(edited);
  });

  it("refuses a file that does not match its checksum, an HTTP error, or an oversized body, leaving nothing behind", async () => {
    const dir = await cache();
    await expect(ensureModel(dir, source, serve({ "config.json": '{"altered":true}' }))).rejects.toThrow("does not match its pinned SHA-256");
    await expect(ensureModel(dir, source, serve({ "tokenizer_config.json": 404 }))).rejects.toThrow("HTTP 404");
    await expect(ensureModel(dir, source, serve({ "config.json": `${config} ` }))).rejects.toThrow("larger than its pinned size");
    expect(await readdir(dir)).toEqual([]);
  });

  it("replaces a model directory that does not match, such as one a failed download left behind", async () => {
    const dir = await cache();
    await mkdir(path.join(dir, name), { recursive: true });
    await writeFile(path.join(dir, name, "config.json"), '{"partial":');
    await ensureModel(dir, source, serve());
    expect(await readdir(dir)).toEqual([name]);
    expect(await readFile(path.join(dir, name, "config.json"), "utf8")).toBe(config);
  });
});
