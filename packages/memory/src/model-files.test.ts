import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlagEmbedding } from "fastembed";
import { ensureModel, type ModelSource } from "./model-files.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const name = "fast-all-MiniLM-L6-v2";
const config = '{"fixture":true}';

/** One USTAR file entry followed by the end-of-archive blocks. */
function archive(file: string, body: string): Buffer {
  const data = Buffer.from(body);
  const header = Buffer.alloc(512);
  header.write(file, 0, 100);
  header.write("0000644", 100);
  header.write("0000000", 108);
  header.write("0000000", 116);
  header.write(data.length.toString(8).padStart(11, "0"), 124);
  header.write("00000000000", 136);
  header.fill(32, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write(
    `${header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, "0")}\0 `,
    148,
  );
  return gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512), Buffer.alloc(1024)]));
}

const bytes = archive(`${name}/config.json`, config);
const source: ModelSource = { name, url: "https://models.example/minilm.tar.gz", sha256: sha256(bytes), bytes: bytes.length, files: { "config.json": sha256(config) } };
const serve = (body: Buffer, status = 200) => vi.fn<typeof fetch>(async () => new Response(new Uint8Array(body), { status }));

async function cache() {
  const root = await mkdtemp(path.join(os.tmpdir(), "openorc-model-files-"));
  dirs.push(root);
  return path.join(root, "models");
}

describe("ensureModel", () => {
  it("downloads and checks the archive, then leaves it for fastembed to extract", async () => {
    const dir = await cache();
    const fetchModel = serve(bytes);
    await ensureModel(dir, source, fetchModel);
    expect(fetchModel).toHaveBeenCalledWith(source.url);
    expect(await readdir(dir)).toEqual([`${name}.tar.gz`]);
    await expect(FlagEmbedding.init({ model: name as never, cacheDir: dir, showDownloadProgress: false })).rejects.toThrow("Tokenizer file not found");
    expect(await readFile(path.join(dir, name, "config.json"), "utf8")).toBe(config);
    await ensureModel(dir, source, fetchModel);
    expect(fetchModel).toHaveBeenCalledTimes(1);
  });

  it("refuses a download that does not match its checksum, an HTTP error, or an oversized body, leaving nothing behind", async () => {
    const dir = await cache();
    await expect(ensureModel(dir, source, serve(archive(`${name}/config.json`, '{"altered":true}')))).rejects.toThrow("does not match its pinned SHA-256");
    await expect(ensureModel(dir, source, serve(Buffer.from("Not Found"), 404))).rejects.toThrow("HTTP 404");
    await expect(ensureModel(dir, { ...source, bytes: bytes.length - 1 }, serve(bytes))).rejects.toThrow("larger than the pinned archive");
    expect(await readdir(dir)).toEqual([]);
  });

  it("replaces a model directory that does not match, such as one a failed download left behind", async () => {
    const dir = await cache();
    await mkdir(path.join(dir, name), { recursive: true });
    await writeFile(path.join(dir, name, "config.json"), '{"partial":');
    await writeFile(path.join(dir, `${name}.tar.gz`), bytes.subarray(0, 20));
    await ensureModel(dir, source, serve(bytes));
    expect(await readdir(dir)).toEqual([`${name}.tar.gz`]);
    expect(sha256(await readFile(path.join(dir, `${name}.tar.gz`)))).toBe(source.sha256);
  });
});
