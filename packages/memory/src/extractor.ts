import type { MemoryType } from "@openorc/protocol";
import { TextGenerator, type TextGeneratorOptions, type TextGenerationProvider } from "./text-generator.js";
export { parseTitle } from "./text-generator.js";
export type ExtractorOptions = TextGeneratorOptions;
export type ExtractionProvider = TextGenerationProvider;
import { renderDigest, type RunDigest } from "./transcript.js";

export interface ExtractedSummary {
  request: string;
  workDone: string;
  outcome: string;
  openItems: string[];
}

export interface ExtractedMemory {
  type: MemoryType;
  title: string;
  body: string;
  topicKey: string | null;
  files: string[];
  confidence: number;
}

export interface Extraction {
  summary: ExtractedSummary;
  memories: ExtractedMemory[];
}

const MEMORY_TYPES: MemoryType[] = ["decision", "spec", "lesson", "preference", "convention", "command", "env_quirk", "ownership"];

const SYSTEM = `You distill a finished coding-agent run into durable memory for future runs on the same project.
Return ONLY minified JSON, no prose, no code fences, matching exactly:
{"summary":{"request":string,"workDone":string,"outcome":string,"openItems":string[]},
 "memories":[{"type":"decision|spec|lesson|preference|convention|command|env_quirk|ownership","title":string,"body":string,"topicKey":string|null,"files":string[],"confidence":number}]}
Rules:
- Record only what helps a future run: failed approaches with the cause, decisions with rationale, commands that worked, environment quirks, conventions, durable preferences. Skip anything obvious from reading the code.
- title <= 80 chars, imperative. body <= 400 chars, concrete.
- topicKey groups memories that supersede each other, like "test/pool" or "architecture/auth"; null if none.
- confidence 0.3-0.9: higher when the run proved it, lower when inferred.
- 0 to 6 memories. Prefer none over noise.`;

/** Codex enforces this schema on its final message, so the reply is JSON by construction. */
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "memories"],
  properties: {
    summary: {
      type: "object",
      additionalProperties: false,
      required: ["request", "workDone", "outcome", "openItems"],
      properties: { request: { type: "string" }, workDone: { type: "string" }, outcome: { type: "string" }, openItems: { type: "array", items: { type: "string" } } },
    },
    memories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "title", "body", "topicKey", "files", "confidence"],
        properties: {
          type: { type: "string", enum: MEMORY_TYPES },
          title: { type: "string" },
          body: { type: "string" },
          topicKey: { type: ["string", "null"] },
          files: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
        },
      },
    },
  },
};

/**
 * Runs a cheap model over the run digest to produce a summary and typed
 * memories. Spawns the unmodified vendor CLI under the user's own login:
 * Claude Code print mode or Codex exec, whichever the user chose. Returns
 * null (never throws) when the CLI is absent or the output cannot be parsed,
 * so a failed extraction never breaks a run.
 */
export class Extractor extends TextGenerator {
  async extract(digest: RunDigest, context: { taskTitle: string; taskSpec: string | null }): Promise<Extraction | null> {
    const prompt = [SYSTEM, "", `Project task: ${context.taskTitle}`, context.taskSpec ? `Spec: ${context.taskSpec}` : "", "", "Run to distill:", renderDigest(digest)].join("\n");

    const raw = await this.ask(prompt, OUTPUT_SCHEMA);
    if (!raw) return null;
    return parseExtraction(raw);
  }
}

/** Tolerant parse: strips fences, finds the JSON object, validates types. */
export function parseExtraction(raw: string): Extraction | null {
  const cleaned = raw.replace(/```json\s*|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  const o = record(obj);
  if (!o) return null;
  const s = record(o["summary"]) ?? {};
  const summary: ExtractedSummary = {
    request: str(s["request"]),
    workDone: str(s["workDone"]),
    outcome: str(s["outcome"]) || "unknown",
    openItems: Array.isArray(s["openItems"]) ? s["openItems"].filter((x): x is string => typeof x === "string") : [],
  };
  const rawMems: unknown[] = Array.isArray(o["memories"]) ? o["memories"] : [];
  const memories: ExtractedMemory[] = [];
  for (const candidate of rawMems.slice(0, 6)) {
    const m = record(candidate);
    if (!m) continue;
    const type = MEMORY_TYPES.find((name) => name === m["type"]) ?? "lesson";
    const title = str(m["title"]).slice(0, 120);
    const body = str(m["body"]).slice(0, 800);
    if (!title || !body) continue;
    memories.push({
      type,
      title,
      body,
      topicKey: typeof m["topicKey"] === "string" && m["topicKey"].trim() ? m["topicKey"].trim() : null,
      files: Array.isArray(m["files"]) ? m["files"].filter((x): x is string => typeof x === "string").slice(0, 20) : [],
      confidence: clamp(typeof m["confidence"] === "number" && Number.isFinite(m["confidence"]) ? m["confidence"] : 0.6),
    });
  }
  return { summary, memories };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function clamp(n: number): number {
  return Math.max(0.1, Math.min(1, n));
}
