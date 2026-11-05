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
  type LineSpan,
} from "@openorc/protocol";
import { answerSchemas, coarseNotes, EXPLAINER, explanationParts, explanationPrompt, joinParts, parseAnswer, uncoveredStretches, withSteps } from "./code-explanation-answers.js";
import type { Completion } from "./text-generation.js";

/** Part of every cache key: a changed prompt asks again rather than serving answers to the old one. */
const PROMPT_VERSION = 16;
/** Model requests running at once, across every explanation; each is its own CLI process. */
const AT_ONCE = 5;
/** Notes too broad to read line by line that one part asks about again, at most. */
const REFINED = 6;
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
type Part = { kind: "explained"; explanation: CodeExplanation; model: Explained["model"] } | { kind: "unavailable"; reason: string } | { kind: "failed" };

const failed = { kind: "failed", reason: "The model didn't return a usable explanation. Try again." } as const;

/** At most `size` model requests run at once; the rest wait their turn in order. */
class Slots {
  private waiting: (() => void)[] = [];
  constructor(private free: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}
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
  private readonly slots = new Slots(AT_ONCE);
  constructor(private readonly deps: Dependencies) {}

  async explain(request: ExplainRequest, conversation: ExplainConversation): Promise<CodeExplainResult> {
    const reason = limitReason(request.text);
    if (reason) return { kind: "unavailable", reason, settings: false };
    const result = await this.result(request, conversation);
    if (result.kind !== "explained" || result.explanation.view !== "walkthrough") return result;
    return { ...result, explanation: await withUsages(result.explanation, request.path, conversation.find) };
  }

  /** The kept explanation of this text and view, else a new one. */
  private async result(request: ExplainRequest, conversation: ExplainConversation): Promise<CodeExplainResult> {
    const key = createHash("sha256")
      .update(JSON.stringify([PROMPT_VERSION, request.view, request.path, request.text]))
      .digest("hex");
    return (!request.refresh && (await this.read(key, request.view))) || this.generation(key, request, conversation);
  }

  /** One request per text and view at a time; a second ask while the first runs waits for the same answer. */
  private generation(key: string, request: ExplainRequest, conversation: ExplainConversation): Promise<CodeExplainResult> {
    const running = this.running.get(key) ?? this.generate(key, request, conversation).finally(() => this.running.delete(key));
    this.running.set(key, running);
    return running;
  }

  private async generate(key: string, request: ExplainRequest, conversation: ExplainConversation): Promise<CodeExplainResult> {
    const { result, whole } = request.view === "walkthrough" ? await this.walkthrough(request, conversation) : { result: await this.joined(request, conversation), whole: true };
    if (result.kind === "explained" && whole) await this.write(key, result);
    return result;
  }

  /** The walkthrough's blocks, each with the file's line notes, the Plain English explanation, as its steps. */
  /**
   * The walkthrough's blocks, each with the file's line notes, the Plain English explanation, as its steps. When the
   * notes fail the blocks still show, without steps, and aren't kept, so asking again can fill the steps in.
   */
  private async walkthrough(request: ExplainRequest, conversation: ExplainConversation): Promise<{ result: CodeExplainResult; whole: boolean }> {
    const [blocks, english] = await Promise.all([this.joined(request, conversation), this.result({ ...request, view: "english" }, conversation)]);
    if (blocks.kind !== "explained" || blocks.explanation.view !== "walkthrough") return { result: blocks, whole: false };
    const notes = english.kind === "explained" && english.explanation.view === "english" ? english.explanation.notes : null;
    return { result: { ...blocks, explanation: withSteps(blocks.explanation, notes ?? []) }, whole: notes !== null };
  }

  /** Every part of the file asked about at once, joined in order. */
  private async joined(request: ExplainRequest, conversation: ExplainConversation): Promise<CodeExplainResult> {
    const parts = await Promise.all(explanationParts(request.view, request.text).map((range) => this.part(request, conversation, range)));
    const unavailable = parts.find((part) => part.kind === "unavailable");
    if (unavailable?.kind === "unavailable") return { kind: "unavailable", reason: unavailable.reason, settings: true };
    const explained = parts.filter((part) => part.kind === "explained");
    const explanation = explained.length === parts.length ? joinParts(explained.map((part) => part.explanation)) : null;
    if (!explanation || !explained[0]) return failed;
    return { kind: "explained", explanation, model: explained[0].model, createdAt: (this.deps.now ?? Date.now)() };
  }

  /**
   * One part explained, then mended once: a note too broad to read is asked about again on its own lines and replaced
   * by the finer notes, and a stretch the model skipped is asked about on its own and filled in.
   */
  private async part(request: ExplainRequest, conversation: ExplainConversation, range: LineSpan): Promise<Part> {
    const first = await this.ask(request, conversation, range);
    if (first.kind !== "explained" || first.explanation.view !== "english") return first;
    const coarse = coarseNotes(first.explanation.notes, request.text);
    const skipped = uncoveredStretches(first.explanation.notes, range, request.text);
    const asks = [...coarse.map((note) => note.lines), ...skipped].slice(0, REFINED);
    if (!asks.length) return first;
    const answers = await Promise.all(asks.map((lines, index) => this.ask(request, conversation, lines, index < coarse.length ? "split" : undefined)));
    const notesFor = (index: number) => {
      const answer = answers[index];
      return answer?.kind === "explained" && answer.explanation.view === "english" ? answer.explanation.notes : [];
    };
    const notes = first.explanation.notes.flatMap((note) => {
      const at = coarse.indexOf(note);
      const finer = at >= 0 && at < asks.length ? notesFor(at) : [];
      if (finer.length < 2) return [note];
      // The broad note keeps the lines before the finer ones, so an opening line never lands under the note above it.
      const opening = finer[0]!;
      return [...(opening.lines.start > note.lines.start ? [{ ...note, lines: { start: note.lines.start, end: opening.lines.start - 1 } }] : []), ...finer];
    });
    const filled = skipped.flatMap((_, index) => notesFor(coarse.length + index));
    return { ...first, explanation: { view: "english", notes: [...notes, ...filled].sort((a, b) => a.lines.start - b.lines.start) } };
  }

  /** One request for one part, asked a second time when the first answer can't be used. */
  private async ask(request: ExplainRequest, conversation: ExplainConversation, range: LineSpan, again?: "split"): Promise<Part> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await this.slots.run(() =>
        this.deps.complete({
          prompt: explanationPrompt(request.view, request.path, request.text, range, again),
          schema: answerSchemas[request.view],
          system: EXPLAINER,
          agent: conversation.agent,
          ...(conversation.claudeAccountId ? { claudeAccountId: conversation.claudeAccountId } : {}),
        }),
      );
      if (answer.kind === "unavailable") return answer;
      const explanation = answer.kind === "answered" ? parseAnswer(request.view, answer.text, range, request.text) : null;
      if (answer.kind === "answered" && explanation) return { kind: "explained", explanation, model: answer.model };
    }
    return { kind: "failed" };
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
