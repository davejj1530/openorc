import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EmbeddingModel, FlagEmbedding } from "fastembed";

const require = createRequire(import.meta.url);
const commonjs: typeof import("fastembed") = require("fastembed");
interface Encoding {
  getIds(): number[];
  getAttentionMask(): number[];
  getTypeIds(): number[];
}
interface Tokenizer {
  encode(text: string): Encoding;
  padId: number;
}
const { loadTokenizer }: { loadTokenizer(dir: string, maxLength: number): Tokenizer } = require(path.resolve(require.resolve("fastembed"), "../../minilm-tokenizer.cjs"));
const dirs: string[] = [];
const special = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture({ model = "sentence-transformers/all-MiniLM-L6-v2", padId = 0, inconsistentSpecial = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-tokenizer-"));
  dirs.push(dir);
  const token = (id: string) => ({ SpecialToken: { id, type_id: 0 } });
  const source = {
    version: "1.0",
    // These file defaults must be superseded by FastEmbed's effective budget.
    truncation: { direction: "Right", max_length: 4, strategy: "LongestFirst", stride: 0 },
    padding: { strategy: { Fixed: 4 }, direction: "Right", pad_id: 0, pad_type_id: 0, pad_token: "[PAD]" },
    added_tokens: special.map((content, id) => ({ id, content, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true })),
    normalizer: { type: "BertNormalizer", clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: true },
    pre_tokenizer: { type: "BertPreTokenizer" },
    post_processor: {
      type: "TemplateProcessing",
      single: [token("[CLS]"), { Sequence: { id: "A", type_id: 0 } }, token("[SEP]")],
      pair: [token("[CLS]"), { Sequence: { id: "A", type_id: 0 } }, token("[SEP]"), { Sequence: { id: "B", type_id: 1 } }, token("[SEP]")],
      special_tokens: Object.fromEntries(["[CLS]", "[SEP]"].map((id) => [id, { id, ids: [special.indexOf(id)], tokens: [id] }])),
    },
    decoder: { type: "WordPiece", prefix: "##", cleanup: true },
    model: {
      type: "WordPiece",
      unk_token: "[UNK]",
      continuing_subword_prefix: "##",
      max_input_chars_per_word: 100,
      vocab: Object.fromEntries([...special, "hello", "world", "cafe", "##s"].map((word, id) => [word, id])),
    },
  };
  const files = {
    "tokenizer.json": source,
    "config.json": { _name_or_path: model, pad_token_id: padId },
    "tokenizer_config.json": { model_max_length: 8, pad_token: "[PAD]", unk_token: "[UNK]" },
    "special_tokens_map.json": { cls_token: inconsistentSpecial ? "[MISSING]" : "[CLS]", sep_token: "[SEP]", pad_token: "[PAD]", mask_token: "[MASK]", unk_token: "[UNK]" },
  };
  await Promise.all(Object.entries(files).map(([name, value]) => writeFile(path.join(dir, name), JSON.stringify(value))));
  return dir;
}

describe("MiniLM tokenizer adapter", () => {
  it("preserves normalized WordPiece IDs, special tokens and masks, leaving padding to the batch", async () => {
    const tokenizer = loadTokenizer(await fixture(), 512);
    const encoded = await tokenizer.encode("Héllo CAFÉS world");
    expect(encoded.getIds()).toEqual([2, 5, 7, 8, 6, 3]);
    expect(encoded.getAttentionMask()).toEqual([1, 1, 1, 1, 1, 1]);
    expect(encoded.getTypeIds()).toEqual([0, 0, 0, 0, 0, 0]);
    expect(tokenizer.padId).toBe(0);
  });

  it("reserves the final separator when truncating content", async () => {
    const tokenizer = loadTokenizer(await fixture(), 4);
    const encoded = await tokenizer.encode("hello world cafe hello world");
    expect(encoded.getIds()).toEqual([2, 5, 6, 3]);
    expect(encoded.getAttentionMask()).toEqual([1, 1, 1, 1]);
  });

  it("handles empty input and literal special tokens without mutating earlier rows", async () => {
    const tokenizer = loadTokenizer(await fixture(), 6);
    const empty = await tokenizer.encode("");
    const literal = await tokenizer.encode("[CLS] hello [MASK]");
    expect(literal.getIds()).toEqual([2, 2, 5, 4, 3]);
    expect(empty.getIds()).toEqual([2, 3]);
    expect(empty.getAttentionMask()).toEqual([1, 1]);
  });

  it("rejects unsupported models before returning an embedding tokenizer", async () => {
    const dir = await fixture({ model: "different/model" });
    expect(() => loadTokenizer(dir, 8)).toThrow(/only the reviewed MiniLM/);
  });

  it("rejects inconsistent special-token and padding configurations", async () => {
    const specialDir = await fixture({ inconsistentSpecial: true });
    const paddingDir = await fixture({ padId: 99 });
    expect(() => loadTokenizer(specialDir, 8)).toThrow(/special-token map/);
    expect(() => loadTokenizer(paddingDir, 8)).toThrow(/padding configuration/);
  });

  it("rejects a budget too short for the special-token template", async () => {
    const dir = await fixture();
    expect(() => loadTokenizer(dir, 1)).toThrow(/token budget/);
  });
});

// Public initialization must route both bundled formats through the adapter.
it.each([
  ["ESM", FlagEmbedding],
  ["CommonJS", commonjs.FlagEmbedding],
] as const)("%s initialization rejects a model outside the reviewed configuration", async (_format, embedding) => {
  const dir = await fixture({ model: "different/model" });
  await expect(embedding.init({ model: EmbeddingModel.CUSTOM, modelAbsoluteDirPath: dir, modelName: "fixture" })).rejects.toThrow(/only the reviewed MiniLM/);
});

// Padding every text to the model maximum made each embedding cost a 512-token pass.
it.each([
  ["ESM", FlagEmbedding],
  ["CommonJS", commonjs.FlagEmbedding],
] as const)("%s embedding pads each batch only to its longest text", async (_format, embedding) => {
  const tokenizer = loadTokenizer(await fixture(), 512);
  const inputs: Array<{ dims: readonly number[]; ids: bigint[]; mask: bigint[]; types: bigint[] }> = [];
  const session = {
    run: async (feed: Record<string, { dims: readonly number[]; data: BigInt64Array }>) => {
      const dims = feed["input_ids"]!.dims;
      inputs.push({ dims, ids: [...feed["input_ids"]!.data], mask: [...feed["attention_mask"]!.data], types: [...feed["token_type_ids"]!.data] });
      return { last_hidden_state: { data: new Float32Array(dims[0]! * dims[1]! * 2).fill(1), dims: [dims[0], dims[1], 2] } };
    },
  };
  const Model = embedding as unknown as new (tokenizer: Tokenizer, session: unknown, model: EmbeddingModel) => FlagEmbedding;
  const vectors: number[][] = [];
  for await (const batch of new Model(tokenizer, session, EmbeddingModel.AllMiniLML6V2).embed(["hello", "hello world cafe"], 32)) vectors.push(...batch);
  expect(inputs).toEqual([{ dims: [2, 5], ids: [2n, 5n, 3n, 0n, 0n, 2n, 5n, 6n, 7n, 3n], mask: [1n, 1n, 1n, 0n, 0n, 1n, 1n, 1n, 1n, 1n], types: Array(10).fill(0n) }]);
  expect(vectors).toHaveLength(2);
});
