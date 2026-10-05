import { shellSteps, unwrapShell } from "../lib/shell";
import { commandOf } from "../lib/tool-view";
import type { Block } from "../lib/transcript";
import { patchStat } from "./diff-stat";
import { toolCallPresentation } from "./tool-presentation";

/** What a chip stands for, which decides its icon and whether it opens anything. */
export type ChipKind = "file" | "folder" | "query" | "command" | "intent" | "web" | "tool" | "agent" | "memory";

export interface WorkChip {
  key: string;
  label: string;
  title: string;
  kind: ChipKind;
  /** A local file the chip opens. */
  path?: string;
  added?: number;
  removed?: number;
  blocks: Block[];
}

/** One call's share of a phase: the section it goes under and the chip it adds there, if any. */
export interface CallPart {
  section: string;
  chip: Omit<WorkChip, "blocks"> | null;
}

type ToolBlock = Extract<Block, { kind: "tool" }>;
type CommandAction = { type?: unknown; command?: unknown; name?: unknown; path?: unknown; query?: unknown };

const text = (value: unknown) => (typeof value === "string" ? value : "");

export function basename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  );
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A command as a chip: the first line of its first step that does something, past a `cd` or a comment. The title keeps it whole. */
export function commandLabel(command: string): string {
  const steps = shellSteps(unwrapShell(command.trim()));
  const step = steps.find((candidate) => !/^(cd\s|#)/.test(candidate.text)) ?? steps[0];
  return (step?.text.split("\n")[0] ?? "").trim();
}

/** The shell command a call ran, whichever field its provider used. */
export function commandText(block: ToolBlock): string {
  return commandOf(block.input as Record<string, unknown> | null);
}

/** The agent's own words for what a call is for. Only shells and subagents carry them; other tools' descriptions are content. */
export function toolIntent(block: ToolBlock): string | null {
  if (!/^(bash|task|agent)$/i.test(block.name)) return null;
  const description = (block.input as { description?: unknown } | null)?.description;
  return typeof description === "string" && description.trim() ? description.trim() : null;
}

const lines = (value: string) => (value ? value.split("\n").length : 0);

/** Lines an edit added and removed: the old and new text without the lines they share at either end. */
function lineDelta(before: string, after: string): { added: number; removed: number } {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { added: b.length - start - end, removed: a.length - start - end };
}

/** Per file, what a successful edit call changed. A failed edit changed nothing, so it has no numbers. */
function editStats(block: ToolBlock): Map<string, { added?: number; removed?: number }> {
  const stats = new Map<string, { added?: number; removed?: number }>();
  if (block.isError) return stats;
  if (Array.isArray(block.input)) {
    for (const entry of block.input as { path?: unknown; diff?: unknown }[])
      if (typeof entry?.path === "string") {
        const { insertions, deletions } = patchStat(text(entry.diff));
        stats.set(entry.path, { added: insertions, removed: deletions });
      }
    return stats;
  }
  const input = (block.input ?? {}) as Record<string, unknown>;
  const path = text(input["file_path"]) || text(input["path"]);
  if (!path) return stats;
  const edits = Array.isArray(input["edits"]) ? (input["edits"] as Record<string, unknown>[]) : [input];
  if (typeof input["content"] === "string") stats.set(path, { added: lines(input["content"]) });
  else if (edits.every((edit) => typeof edit?.["old_string"] === "string" && typeof edit["new_string"] === "string")) {
    const total = edits
      .map((edit) => lineDelta(text(edit["old_string"]), text(edit["new_string"])))
      .reduce((sum, d) => ({ added: sum.added + d.added, removed: sum.removed + d.removed }), { added: 0, removed: 0 });
    stats.set(path, total);
  }
  return stats;
}

function fileChip(path: string, stat?: { added?: number; removed?: number }): Omit<WorkChip, "blocks"> {
  return { key: path, label: basename(path), title: path, kind: "file", path, ...stat };
}

/** Codex reads each command for what it does: a `sed` that prints a file is a read, an `rg` is a search. */
function actionPart(action: CommandAction): CallPart {
  const command = text(action.command);
  if (action.type === "read") {
    const path = text(action.path) || text(action.name);
    return { section: "Read", chip: { ...fileChip(path), label: text(action.name) || basename(path) } };
  }
  if (action.type === "search") return { section: "Searched", chip: { key: text(action.query) || command, label: text(action.query) || command, title: command, kind: "query" } };
  if (action.type === "listFiles") return { section: "Listed", chip: { key: text(action.path) || command, label: text(action.path) || command, title: command, kind: "folder" } };
  return { section: "Ran", chip: { key: command, label: commandLabel(command), title: command, kind: "command" } };
}

const sectionFor: Record<string, { section: string; kind: ChipKind }> = {
  Read: { section: "Read", kind: "file" },
  Searched: { section: "Searched", kind: "query" },
  Ran: { section: "Ran", kind: "command" },
  Fetched: { section: "Fetched", kind: "web" },
  "Searched the web for": { section: "Searched the web", kind: "web" },
  "Searched memory for": { section: "Searched memory", kind: "memory" },
  Remembered: { section: "Remembered", kind: "memory" },
  Delegated: { section: "Delegated", kind: "agent" },
};

/** A page reads as its site, a command as its first line, anything else as written. */
function chipLabel(verb: string, kind: ChipKind | undefined, object: string): string {
  if (verb === "Fetched") return hostname(object);
  if (kind === "command") return commandLabel(object);
  return object.replace(/\s+/g, " ").trim();
}

function presentedParts(block: ToolBlock): CallPart[] {
  const { verb, object, summary } = toolCallPresentation(block.name, block.input);
  // An MCP call reads as "Used Mobbin" with the tool it called as the chip; what it asked stays in the title.
  if (summary) {
    const action = verb.replace(/^[^:]+: /, "");
    return [{ section: summary, chip: { key: action, label: action, title: object ? `${verb} · ${object}` : verb, kind: "tool" } }];
  }
  if (verb === "Edited") {
    const stats = editStats(block);
    // A patch that names no single file reads as its count ("3 files"), which is not a path to open.
    if (/^\d+ files?$/.test(object)) return [{ section: "Edited", chip: { key: object, label: object, title: object, kind: "tool" } }];
    const paths = Array.isArray(block.input) ? (block.input as { path?: unknown }[]).flatMap((entry) => (typeof entry?.path === "string" ? [entry.path] : [])) : [object].filter(Boolean);
    return paths.length ? paths.map((path) => ({ section: "Edited", chip: fileChip(path, stats.get(path)) })) : [{ section: "Edited", chip: null }];
  }
  const known = sectionFor[verb];
  if (!object) return [{ section: known?.section ?? verb, chip: null }];
  if (known?.kind === "file") return [{ section: known.section, chip: fileChip(object) }];
  const label = chipLabel(verb, known?.kind, object);
  return [{ section: known?.section ?? verb, chip: { key: label, label, title: object, kind: known?.kind ?? "tool" } }];
}

/** Which sections a call belongs to and what it adds to each. Every call lands in at least one section. */
export function callParts(block: Block): CallPart[] {
  if (block.kind === "activity") return [{ section: block.label, chip: null }];
  if (block.kind !== "tool") return [{ section: block.kind, chip: null }];
  const intent = toolIntent(block);
  if (intent) {
    const agent = !/^bash$/i.test(block.name);
    return [{ section: agent ? "Delegated" : "Ran", chip: { key: `intent:${block.id}`, label: intent, title: agent ? intent : commandText(block) || intent, kind: agent ? "agent" : "intent" } }];
  }
  const actions = (block.input as { commandActions?: unknown } | null)?.commandActions;
  const parsed = Array.isArray(actions) ? actions.filter((action): action is CommandAction => typeof action === "object" && action !== null) : [];
  return parsed.length ? parsed.map(actionPart) : presentedParts(block);
}
