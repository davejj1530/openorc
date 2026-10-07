import { open } from "node:fs/promises";
import { join } from "node:path";
import { grepWorkingTree, type GrepLine } from "@openorc/git";
import type { FindGroup, FindQuery, FindResult } from "@openorc/protocol";

/** Lines a find answers, in all and from one file. */
const LIMITS = { total: 2_000, perFile: 100 };
/** A find that runs this long stops and answers what it found. */
const BUDGET_MS = 15_000;
/** The walk skips larger files, as a bundle or a data dump would be. */
const WALK_FILE_BYTES = 1024 * 1024;
/** Characters of a line shown, and how many of them come before its first match. */
const SHOWN = 240;
const LEAD = 40;

/** Where a find looks: the folder, whether git tracks it, and its files as the @ mention listing has them. */
export interface FindFolder {
  root: string;
  git: boolean;
  files: () => Promise<string[]>;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The query as a JavaScript expression: the walk's matcher, and where each line's excerpt starts. */
function expression(query: FindQuery): RegExp | { invalid: string } {
  try {
    return new RegExp(query.regex ? query.text : escape(query.text), query.caseSensitive ? "" : "i");
  } catch (error) {
    return { invalid: error instanceof Error ? error.message : String(error) };
  }
}

/** A line as shown: no line ending or indentation, starting a little before its first match, cut to what a panel shows. */
function excerpt(text: string, pattern: RegExp | null): string {
  const line = text.replace(/\r$/, "");
  const indent = line.length - line.trimStart().length;
  const match = pattern ? line.search(pattern) : -1;
  const start = match - LEAD > indent ? match - LEAD : indent;
  const end = start + SHOWN;
  return `${start > indent ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

function grouped(lines: GrepLine[], truncated: boolean, pattern: RegExp | null): FindResult {
  const groups = new Map<string, FindGroup>();
  for (const { path, line, text } of lines) {
    const group = groups.get(path) ?? { path, lines: [] };
    group.lines.push({ line, text: excerpt(text, pattern) });
    groups.set(path, group);
  }
  return { kind: "matches", groups: [...groups.values()], truncated };
}

/** A file's text, or null when it is gone, larger than the walk reads, or binary. */
async function textOf(path: string): Promise<string | null> {
  const file = await open(path, "r").catch(() => null);
  if (!file) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > WALK_FILE_BYTES) return null;
    const bytes = await file.readFile();
    return bytes.includes(0) ? null : new TextDecoder().decode(bytes);
  } finally {
    await file.close();
  }
}

/** Reads the folder's listing file by file, so a find over a home folder never blocks the core and stops when asked. */
async function walk(folder: FindFolder, pattern: RegExp, signal: AbortSignal): Promise<{ lines: GrepLine[]; truncated: boolean }> {
  const lines: GrepLine[] = [];
  let truncated = false;
  for (const path of await folder.files()) {
    if (signal.aborted) return { lines, truncated: true };
    const text = await textOf(join(folder.root, path));
    if (text === null) continue;
    let count = 0;
    for (const [index, line] of text.split("\n").entries()) {
      if (!pattern.test(line)) continue;
      if (++count > LIMITS.perFile) {
        truncated = true;
        break;
      }
      if (lines.length === LIMITS.total) return { lines, truncated: true };
      lines.push({ path, line: index + 1, text: line });
    }
  }
  return { lines, truncated };
}

/**
 * Find in files: `git grep` where git tracks the folder, else a walk of its listing. Both stop at the same limits,
 * after the same time budget and when `signal` aborts, answering what they found marked truncated. A regular
 * expression follows git's extended syntax in git folders and JavaScript's elsewhere; literal text means the same in
 * both.
 */
export async function findInFolder(folder: FindFolder, query: FindQuery, signal: AbortSignal): Promise<FindResult> {
  const pattern = expression(query);
  const stop = AbortSignal.any([signal, AbortSignal.timeout(BUDGET_MS)]);
  if (folder.git) {
    const found = await grepWorkingTree(folder.root, { pattern: query.text, fixed: !query.regex, ignoreCase: !query.caseSensitive }, { ...LIMITS, signal: stop });
    if (found.kind === "invalid") return { kind: "invalid", message: `Invalid regular expression: ${found.message}` };
    return grouped(found.lines, found.truncated, pattern instanceof RegExp ? pattern : null);
  }
  if (!(pattern instanceof RegExp)) return { kind: "invalid", message: pattern.invalid };
  const found = await walk(folder, pattern, stop);
  return grouped(found.lines, found.truncated, pattern);
}
