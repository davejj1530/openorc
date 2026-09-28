import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { EmbeddingModel, FlagEmbedding } from "fastembed";

const require = createRequire(import.meta.url);
const commonjs: typeof import("fastembed") = require("fastembed");
const dirs: string[] = [];
const model = EmbeddingModel.AllMiniLML6V2;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Tiny USTAR fixtures keep malformed paths intact, unlike normal archive writers. */
function entry(name: string, body = "", { type = "0", link = "", declaredSize }: { type?: string; link?: string; declaredSize?: number } = {}): Buffer {
  const data = Buffer.from(body);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write("0000644", 100);
  header.write("0000000", 108);
  header.write("0000000", 116);
  header.write((declaredSize ?? data.length).toString(8).padStart(11, "0"), 124);
  header.write("00000000000", 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write(link, 157, 100);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

async function fixture(entries: Buffer[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "openorc-model-archive-"));
  dirs.push(root);
  const cache = path.join(root, "models");
  await mkdir(cache);
  const archive = path.join(cache, `${model}.tar.gz`);
  await writeFile(archive, gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
  return { root, cache, archive };
}

describe.each([
  ["ESM", FlagEmbedding],
  ["CommonJS", commonjs.FlagEmbedding],
] as const)("FastEmbed archive integration (%s)", (_format, embedding) => {
  // Public init uses the cached archive and real extractor, then stops at the
  // deliberately absent tokenizer. No model download or inference is needed.
  const initialize = (cacheDir: string) => embedding.init({ model, cacheDir, showDownloadProgress: false });

  it("extracts a valid model tree with the patched tar API", async () => {
    const { cache, archive } = await fixture([entry(`${model}/config.json`, '{"test":true}')]);
    await expect(initialize(cache)).rejects.toThrow("Tokenizer file not found");
    expect(await readFile(path.join(cache, model, "config.json"), "utf8")).toBe('{"test":true}');
    await expect(stat(archive)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects parent traversal without overwriting an outside file", async () => {
    const { root, cache } = await fixture([entry("../outside.txt", "overwritten")]);
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "original");
    await expect(initialize(cache)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("original");
  });

  it.each(["1", "2"])("does not create archive links (type %s)", async (type) => {
    const { root, cache } = await fixture([entry(`${model}/config.json`, "{}"), entry(`${model}/linked`, "", { type, link: "../outside.txt" })]);
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "original");
    await expect(initialize(cache)).rejects.toThrow("Tokenizer file not found");
    await expect(stat(path.join(cache, model, "linked"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(outside, "utf8")).toBe("original");
  });

  it("rejects an oversized entry before writing its contents", async () => {
    const { cache } = await fixture([entry(`${model}/oversized`, "", { declaredSize: 512 * 1024 * 1024 + 1 })]);
    await expect(initialize(cache)).rejects.toThrow("Model archive exceeds extraction limits");
    await expect(stat(path.join(cache, model, "oversized"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds the number of extracted entries", async () => {
    const { cache } = await fixture(Array.from({ length: 257 }, (_, i) => entry(`${model}/file-${i}`)));
    await expect(initialize(cache)).rejects.toThrow("Model archive exceeds extraction limits");
    await expect(stat(path.join(cache, model, "file-256"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds expanded bytes even after the tar end marker", async () => {
    const { cache, archive } = await fixture([]);
    // Concatenated gzip members expand beyond the limit without allocating or
    // writing a half-gigabyte fixture. Zero blocks are tar end/padding markers.
    const member = gzipSync(Buffer.alloc(1024 * 1024));
    await writeFile(archive, Buffer.concat(Array.from({ length: 513 }, () => member)));
    await expect(initialize(cache)).rejects.toThrow("Model archive exceeds 512 MiB");
    await expect(stat(path.join(cache, model))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects malformed gzip input", async () => {
    const { cache, archive } = await fixture([]);
    await writeFile(archive, "not a gzip archive");
    await expect(initialize(cache)).rejects.toThrow();
    await expect(stat(path.join(cache, model))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["gzip", gzipSync(entry(`${model}/config.json`, "{}"))],
    ["zstd", Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])],
  ] as const)("rejects nested %s before tar can decompress past the byte limit", async (_format, payload) => {
    const { cache, archive } = await fixture([]);
    await writeFile(archive, gzipSync(payload));
    await expect(initialize(cache)).rejects.toThrow("Nested model archive compression is not supported");
    await expect(stat(path.join(cache, model))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
