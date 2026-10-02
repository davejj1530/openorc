import { memories, vectors, type Db } from "@openorc/db";
import type { Memory, MemoryType } from "@openorc/protocol";
import type { Embedder } from "./embedder.js";

export interface RetrievedMemory {
  memory: Memory;
  score: number;
}

export interface RetrieveOptions {
  projectId: string | null;
  /** Searches this Orcling's own memory instead of a project's. */
  orclingId?: string;
  query: string;
  types?: MemoryType[];
  limit?: number;
  /** Whether to match by meaning as well as by words. Off, the embedding model is never loaded or downloaded. */
  semantic?: boolean;
}

// Lessons and hard-won facts outrank conventions and specs at equal relevance.
const TYPE_PRIOR: Record<MemoryType, number> = {
  lesson: 1.3,
  env_quirk: 1.25,
  decision: 1.2,
  command: 1.15,
  convention: 1.0,
  ownership: 0.95,
  preference: 0.95,
  spec: 0.85,
};

const RRF_K = 60;
const HALF_LIFE_MS = 75 * 24 * 60 * 60 * 1000;
const MAX_PER_SESSION = 3;

/**
 * Hybrid retrieval: full-text and vector candidates fused with reciprocal rank
 * fusion, then reranked by type prior, confidence, and recency. Works on FTS
 * alone when embeddings are unavailable.
 */
export class Retriever {
  constructor(
    private readonly db: Db,
    private readonly embedder: Pick<Embedder, "embedQuery">,
    private readonly embeddingTimeoutMs = 500,
  ) {}

  async retrieve(options: RetrieveOptions): Promise<RetrievedMemory[]> {
    const { projectId, orclingId, query } = options;
    const limit = options.limit ?? 8;
    const fused = new Map<string, { memory: Memory; rrf: number }>();

    const fts = orclingId ? memories.searchOrcling(this.db, query, orclingId, 40) : memories.search(this.db, query, projectId, 40);
    fts.forEach(({ memory }, i) => add(fused, memory, 1 / (RRF_K + i + 1)));

    // A first-run model download must not hold up search or an agent's MCP call.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const qv =
      options.semantic === false
        ? null
        : await Promise.race([
            this.embedder.embedQuery(query).catch(() => null),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), this.embeddingTimeoutMs);
            }),
          ]);
    if (timer) clearTimeout(timer);
    if (qv) {
      const vec = orclingId ? vectors.knnOrcling(this.db, qv, orclingId, 40) : vectors.knn(this.db, qv, projectId, 40);
      vec.forEach(({ memory }, i) => add(fused, memory, 1 / (RRF_K + i + 1)));
    }

    const now = Date.now();
    const perSession = new Map<string, number>();
    const ranked = [...fused.values()]
      .filter(({ memory }) => (options.types ? options.types.includes(memory.type) : true))
      .map(({ memory, rrf }) => {
        const recency = Math.pow(0.5, (now - memory.lastConfirmedAt) / HALF_LIFE_MS);
        const score = rrf * TYPE_PRIOR[memory.type] * (0.5 + memory.confidence / 2) * (0.4 + 0.6 * recency);
        return { memory, score };
      })
      .sort((a, b) => b.score - a.score);

    // Cap how many come from any one source run, so a chatty run cannot flood the brief.
    const out: RetrievedMemory[] = [];
    for (const r of ranked) {
      const key = r.memory.sourceRunId ?? r.memory.id;
      const n = perSession.get(key) ?? 0;
      if (n >= MAX_PER_SESSION) continue;
      perSession.set(key, n + 1);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }
}

function add(map: Map<string, { memory: Memory; rrf: number }>, memory: Memory, rrf: number): void {
  const existing = map.get(memory.id);
  if (existing) existing.rrf += rrf;
  else map.set(memory.id, { memory, rrf });
}
