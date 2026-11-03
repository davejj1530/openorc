import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  explainLimits,
  FolderPath,
  type AgentKind,
  type CodeExplainResult,
  type CodeExplanation,
  type CodeUsage,
  type ExplanationView,
  type FindQuery,
  type FindResult,
  type HarnessId,
} from "@openorc/protocol";
import { answerSchemas, EXPLAINER, explanationPrompt, parseAnswer } from "./code-explanation-answers.js";
import type { Completion } from "./text-generation.js";

/** Part of every cache key: a changed prompt asks again rather than serving answers to the old one. */
const PROMPT_VERSION = 2;
/** Explanations kept on disk; the oldest go first. */
const KEPT = 300;
/** Files listed under a block's "Used by". */
const USED_BY = 8;
/** A name found in more files than this is too common to say who uses this file's. */
const COMMON = 25;
/** FindQuery's own bound on the pattern. */
const PATTERN_MAX = 500;

export interface ExplainRequest {
  path: FolderPath;
  text: string;
  view: ExplanationView;
  refresh?: boolean;
}

/** The conversation a file belongs to: whose model explains it, and how to search its folder. */
export interface ExplainConversation {
  agent: AgentKind;
  claudeAccountId?: string;
  find: (query: FindQuery) => Promise<FindResult>;
}

interface Dependencies {
  dir: string;
  complete: (request: { prompt: string; schema: object; system: string; agent: AgentKind; claudeAccountId?: string }) => Promise<Completion>;
  now?: () => number;
}

type Explained = Extract<CodeExplainResult, { kind: "explained" }>;
type Walkthrough = Extract<CodeExplanation, { view: "walkthrough" }>;

const lineCount = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
const count = (value: number) => value.toLocaleString("en-US");

function limitReason(text: string): string | null {
  if (!text.trim()) return "This file is empty.";
  const lines = lineCount(text);
  if (lines > explainLimits.lines) return `Explanations cover files up to ${count(explainLimits.lines)} lines. This one has ${count(lines)}.`;
  return null;
}

/**
 * Explains code files with the text-generation model, one view at a time and only when asked. An explanation is kept
 * for the exact text it explains, so reopening a file costs nothing; who uses a block is looked up fresh every time.
 */
export class CodeExplanationService {
  private readonly running = new Map<string, Promise<CodeExplainResult>>();
  constructor(private readonly deps: Dependencies) {}

  async explain(request: ExplainRequest, conversation: ExplainConversation): Promise<CodeExplainResult> {
    const reason = limitReason(request.text);
    if (reason) return { kind: "unavailable", reason, settings: false };
    const key = createHash("sha256")
      .update(JSON.stringify([PROMPT_VERSION, request.view, request.path, request.text]))
      .digest("hex");
    const result = (!request.refresh && (await this.read(key, request.view))) || (await this.generation(key, request, conversation));
    if (result.kind !== "explained" || result.explanation.view !== "walkthrough") return result;
    return { ...result, explanation: await withUsages(result.explanation, request.path, conversation.find) };
  }

  /** One request per text and view at a time; a second ask while the first runs waits for the same answer. */
  private generation(key: string, request: ExplainRequest, conversation: ExplainConversation): Promise<CodeExplainResult> {
    const running = this.running.get(key) ?? this.generate(key, request, conversation).finally(() => this.running.delete(key));
    this.running.set(key, running);
    return running;
  }

  private async generate(key: string, request: ExplainRequest, conversation: ExplainConversation): Promise<CodeExplainResult> {
    const answer = await this.deps.complete({
      prompt: explanationPrompt(request.view, request.path, request.text),
      schema: answerSchemas[request.view],
      system: EXPLAINER,
      agent: conversation.agent,
      ...(conversation.claudeAccountId ? { claudeAccountId: conversation.claudeAccountId } : {}),
    });
    if (answer.kind === "unavailable") return { ...answer, settings: true };
    const explanation = answer.kind === "answered" ? parseAnswer(request.view, answer.text, lineCount(request.text)) : null;
    if (answer.kind !== "answered" || !explanation) return { kind: "failed", reason: "The model didn't return a usable explanation. Try again." };
    const explained: Explained = { kind: "explained", explanation, model: answer.model, createdAt: (this.deps.now ?? Date.now)() };
    await this.write(key, explained);
    return explained;
  }

  private async read(key: string, view: ExplanationView): Promise<Explained | null> {
    try {
      const saved = JSON.parse(await readFile(join(this.deps.dir, `${key}.json`), "utf8")) as Partial<Explained>;
      if (saved.explanation?.view !== view || !saved.model || typeof saved.createdAt !== "number") return null;
      return { kind: "explained", explanation: saved.explanation, model: saved.model as { provider: HarnessId; label: string }, createdAt: saved.createdAt };
    } catch {
      return null;
    }
  }

  /** Best effort: a cache that can't be written costs a repeat request, nothing more. */
  private async write(key: string, explained: Explained): Promise<void> {
    const file = join(this.deps.dir, `${key}.json`);
    try {
      await mkdir(this.deps.dir, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(explained));
      await rename(`${file}.tmp`, file);
      await prune(this.deps.dir);
    } catch {
      await rm(`${file}.tmp`, { force: true }).catch(() => undefined);
    }
  }
}

async function prune(dir: string): Promise<void> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  if (names.length <= KEPT) return;
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(dir, name))).mtimeMs })));
  const oldest = dated.sort((a, b) => a.at - b.at).slice(0, names.length - KEPT);
  await Promise.all(oldest.map(({ name }) => rm(join(dir, name), { force: true })));
}

const boundary = "[^A-Za-z0-9_$]";
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordPattern = (names: string[]) => `(^|${boundary})(${names.map(escape).join("|")})(${boundary}|$)`;

/** Names packed into as few finds as the pattern limit allows. */
function findGroups(names: string[]): string[][] {
  const groups: string[][] = [];
  for (const name of names) {
    const last = groups.at(-1);
    if (last && wordPattern([...last, name]).length <= PATTERN_MAX) last.push(name);
    else if (wordPattern([name]).length <= PATTERN_MAX) groups.push([name]);
  }
  return groups;
}

/**
 * Lines outside the explained file that name each symbol, one per file. A find that reached its line limit may have
 * stopped before some names' callers, so its names are looked up one at a time; a name that fills the limit alone is
 * too common to say who uses this file's.
 */
async function usages(names: string[], path: string, find: ExplainConversation["find"]): Promise<Map<string, CodeUsage[]>> {
  const found = new Map<string, Map<string, CodeUsage>>(names.map((name) => [name, new Map()]));
  const matchers = names.map((name) => ({ name, pattern: new RegExp(wordPattern([name])) }));
  const common = new Set<string>();
  const groups = findGroups(names);
  for (let group = groups.shift(); group; group = groups.shift()) {
    const result = await find({ text: wordPattern(group), regex: true, caseSensitive: true });
    if (result.kind !== "matches") continue;
    if (result.truncated) {
      if (group.length > 1) groups.push(...group.map((name) => [name]));
      else common.add(group[0]!);
      continue;
    }
    for (const file of result.groups) {
      const folderPath = FolderPath.safeParse(file.path);
      if (!folderPath.success || file.path === path) continue;
      for (const hit of file.lines)
        for (const { name, pattern } of matchers)
          if (group.includes(name) && pattern.test(hit.text) && !found.get(name)?.has(file.path)) found.get(name)?.set(file.path, { path: folderPath.data, line: hit.line, text: hit.text });
    }
  }
  return new Map([...found].filter(([name, files]) => files.size <= COMMON && !common.has(name)).map(([name, files]) => [name, [...files.values()]]));
}

async function withUsages(explanation: Walkthrough, path: string, find: ExplainConversation["find"]): Promise<Walkthrough> {
  const names = [...new Set(explanation.blocks.flatMap((block) => block.symbols))];
  if (!names.length) return explanation;
  const found = await usages(names, path, find).catch(() => new Map<string, CodeUsage[]>());
  const usedBy = (symbols: string[]) => {
    const byFile = new Map<string, CodeUsage>();
    for (const usage of symbols.flatMap((name) => found.get(name) ?? [])) if (!byFile.has(usage.path)) byFile.set(usage.path, usage);
    return [...byFile.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, USED_BY);
  };
  return { ...explanation, blocks: explanation.blocks.map((block) => ({ ...block, usedBy: usedBy(block.symbols) })) };
}
