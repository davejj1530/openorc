import path from "node:path";
import { ensureModel } from "./model-files.js";

/**
 * Local sentence embeddings, no API key. Wraps fastembed's all-MiniLM-L6-v2
 * (384 dimensions). The model downloads once into the data directory and is
 * checked against pinned SHA-256 sums on every load; if that fails (offline,
 * locked down, altered), the embedder reports unavailable and retrieval falls
 * back to full-text search.
 */
export class Embedder {
  private model: unknown = null;
  private init: Promise<boolean> | null = null;
  private failed = false;

  constructor(private readonly cacheDir: string) {}

  /** Resolves true once the model is ready. Cached; a failure is remembered. */
  async ready(): Promise<boolean> {
    if (this.failed) return false;
    if (this.model) return true;
    if (!this.init) this.init = this.load();
    return this.init;
  }

  private async load(): Promise<boolean> {
    try {
      const cacheDir = path.join(this.cacheDir, "models");
      await ensureModel(cacheDir);
      const { FlagEmbedding, EmbeddingModel } = (await import("fastembed")) as typeof import("fastembed");
      this.model = await FlagEmbedding.init({ model: EmbeddingModel.AllMiniLML6V2, cacheDir });
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }

  /** Embed one query string, or null if the model is unavailable. */
  async embedQuery(text: string): Promise<Float32Array | null> {
    if (!(await this.ready())) return null;
    const m = this.model as { queryEmbed(t: string): Promise<number[]> | number[] };
    const vec = await m.queryEmbed(text);
    return Float32Array.from(vec);
  }

  /** Embed many documents, or null if the model is unavailable or `stop` asks to end early. Order matches the input. */
  async embed(texts: string[], stop?: () => boolean): Promise<Float32Array[] | null> {
    if (texts.length === 0) return [];
    if (!(await this.ready())) return null;
    const m = this.model as { embed(docs: string[], batchSize?: number): AsyncGenerator<number[][]> };
    const out: Float32Array[] = [];
    for await (const batch of m.embed(texts, 32)) {
      if (stop?.()) return null;
      for (const row of batch) out.push(Float32Array.from(row));
    }
    return out;
  }
}
