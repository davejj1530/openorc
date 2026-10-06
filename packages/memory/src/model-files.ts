import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/** One file of a model, downloaded on its own. */
export interface ModelFile {
  /** SHA-256 of the file as fastembed reads it, after any edits. */
  sha256: string;
  /** The most the download may weigh, before any edits. */
  bytes: number;
  /** Exact text replacements made to the download before it is checked. */
  edits?: readonly (readonly [from: string, to: string])[];
}

/** A model laid out the way fastembed reads it from its cache, each file pinned by SHA-256. */
export interface ModelSource {
  /** fastembed's name for the model: its directory in the cache. */
  name: string;
  /** Each file downloads from here plus its name, at a pinned revision. */
  baseUrl: string;
  files: Record<string, ModelFile>;
}

/**
 * all-MiniLM-L6-v2 from Qdrant's Hugging Face repository, at a pinned revision. The Google Cloud Storage archive
 * fastembed downloads by default refuses anonymous requests since October 2026. The repository holds the same model,
 * vocabulary and configuration; its two tokenizer files carry newer limits, so they are edited back to the archive's.
 * That keeps every pinned SHA-256 the archive had, so existing caches and stored embeddings stay as they are.
 */
export const MINILM: ModelSource = {
  name: "fast-all-MiniLM-L6-v2",
  baseUrl: "https://huggingface.co/Qdrant/all-MiniLM-L6-v2-onnx/resolve/d13954661f83248295ba75c1ed411eef3b7b936e/",
  files: {
    "config.json": { sha256: "1b4d8e2a3988377ed8b519a31d8d31025a25f1c5f8606998e8014111438efcd7", bytes: 650 },
    "model.onnx": { sha256: "bbd7b466f6d58e646fdc2bd5fd67b2f5e93c0b687011bd4548c420f7bd46f0c5", bytes: 90_387_630 },
    "special_tokens_map.json": { sha256: "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a", bytes: 695 },
    "tokenizer.json": {
      sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
      bytes: 711_649,
      edits: [
        ['"max_length": 256,', '"max_length": 128,'],
        ['"strategy": "BatchLongest",', '"strategy": {\n      "Fixed": 128\n    },'],
      ],
    },
    "tokenizer_config.json": {
      sha256: "bd2e06a5b20fd1b13ca988bedc8763d332d242381b4fbc98f8fead4524158f79",
      bytes: 1_412,
      // The tokenizer adapter reads its token limit from model_max_length; 512 keeps embeddings as they were.
      edits: [['"model_max_length": 256,', '"max_length": 128,\n  "model_max_length": 512,']],
    },
    "vocab.txt": { sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3", bytes: 231_508 },
  },
};

/**
 * Makes `cacheDir` hold the model exactly as pinned, so fastembed never downloads it itself. A model directory that
 * does not match, such as one a failed download left behind, is removed. The files then download into a folder of
 * their own, and it takes the model's place only once every file matches its pin.
 */
export async function ensureModel(cacheDir: string, source: ModelSource = MINILM, fetchModel: typeof fetch = fetch): Promise<void> {
  const dir = path.join(cacheDir, source.name);
  if (await matches(dir, source.files)) return;
  await rm(dir, { recursive: true, force: true });
  const partial = `${dir}.part`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  try {
    for (const [name, file] of Object.entries(source.files)) await download(new URL(name, source.baseUrl), file, path.join(partial, name), fetchModel);
    await rename(partial, dir);
  } finally {
    await rm(partial, { recursive: true, force: true });
  }
}

async function matches(dir: string, files: Record<string, ModelFile>): Promise<boolean> {
  for (const [name, file] of Object.entries(files)) if ((await sha256(path.join(dir, name))) !== file.sha256) return false;
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

/** Downloads one file to `target`, makes its edits, and checks it against its pin. */
async function download(url: URL, file: ModelFile, target: string, fetchModel: typeof fetch): Promise<void> {
  const response = await fetchModel(url);
  if (!response.ok || !response.body) throw new Error(`The embedding model download failed with HTTP ${response.status}.`);
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > file.bytes) return callback(new Error("The embedding model download is larger than its pinned size."));
      callback(null, chunk);
    },
  });
  // The DOM and Node libraries each declare fetch's body stream; at run time it is Node's.
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), meter, createWriteStream(target));
  if (file.edits) {
    let text = await readFile(target, "utf8");
    for (const [from, to] of file.edits) text = text.replace(from, () => to);
    await writeFile(target, text);
  }
  if ((await sha256(target)) !== file.sha256) throw new Error("The downloaded embedding model does not match its pinned SHA-256.");
}
