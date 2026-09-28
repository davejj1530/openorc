import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/** A model archive as fastembed packages it, pinned by SHA-256. */
export interface ModelSource {
  /** fastembed's name for the model: its directory in the cache, and the archive's name there. */
  name: string;
  url: string;
  sha256: string;
  bytes: number;
  /** Each file in the model's directory, by SHA-256. */
  files: Record<string, string>;
}

/** all-MiniLM-L6-v2. Its model.onnx has the SHA-256 Hugging Face lists for Qdrant/all-MiniLM-L6-v2-onnx. */
export const MINILM: ModelSource = {
  name: "fast-all-MiniLM-L6-v2",
  url: "https://storage.googleapis.com/qdrant-fastembed/sentence-transformers-all-MiniLM-L6-v2.tar.gz",
  sha256: "2735afe656e156af64ed603dbb1c96f3cae7f937286a8feb27fff7fa979f6a77",
  bytes: 83_180_180,
  files: {
    "config.json": "1b4d8e2a3988377ed8b519a31d8d31025a25f1c5f8606998e8014111438efcd7",
    "model.onnx": "bbd7b466f6d58e646fdc2bd5fd67b2f5e93c0b687011bd4548c420f7bd46f0c5",
    "special_tokens_map.json": "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a",
    "tokenizer.json": "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
    "tokenizer_config.json": "bd2e06a5b20fd1b13ca988bedc8763d332d242381b4fbc98f8fead4524158f79",
    "vocab.txt": "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
  },
};

/**
 * Makes `cacheDir` hold the model exactly as pinned, so fastembed never downloads it itself. A model directory that
 * does not match, such as one a failed download left behind, is removed. The archive is then downloaded and checked,
 * and left where fastembed extracts an archive it finds instead of downloading one.
 */
export async function ensureModel(cacheDir: string, source: ModelSource = MINILM, fetchModel: typeof fetch = fetch): Promise<void> {
  const dir = path.join(cacheDir, source.name);
  if (await matches(dir, source.files)) return;
  await rm(dir, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, `${source.name}.tar.gz`);
  if ((await sha256(archive)) === source.sha256) return;
  await download(source, archive, fetchModel);
}

async function matches(dir: string, files: Record<string, string>): Promise<boolean> {
  for (const [name, expected] of Object.entries(files)) if ((await sha256(path.join(dir, name))) !== expected) return false;
  return true;
}

/** The file's SHA-256, or null when it cannot be read. */
async function sha256(file: string): Promise<string | null> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  } catch {
    return null;
  }
  return hash.digest("hex");
}

async function download(source: ModelSource, archive: string, fetchModel: typeof fetch): Promise<void> {
  const response = await fetchModel(source.url);
  if (!response.ok || !response.body) throw new Error(`The embedding model download failed with HTTP ${response.status}.`);
  const partial = `${archive}.part`;
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > source.bytes) return callback(new Error("The embedding model download is larger than the pinned archive."));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    // The DOM and Node libraries each declare fetch's body stream; at run time it is Node's.
    await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), meter, createWriteStream(partial));
    if (hash.digest("hex") !== source.sha256) throw new Error("The downloaded embedding model does not match its pinned SHA-256.");
    await rename(partial, archive);
  } finally {
    await rm(partial, { force: true });
  }
}
