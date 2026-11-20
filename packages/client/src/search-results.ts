import { folderOf } from "./command-chips.js";
import { basename, type WorkChip } from "./work-chips.js";
import type { SearchObject } from "./work-objects.js";

/**
 * What a search found, for reading rather than as the lines it printed: its hits as the files they are in, the ones
 * the turn went on to open first, and each matching line as words around what matched.
 */
export interface HitFile {
  path: string;
  name: string;
  /** The folder it is in, short, which tells files of one name apart. */
  folder: string;
  /** The turn went on to read or edit it. */
  opened: boolean;
  /** Its matching lines in the order they were printed; none when the search listed files. */
  lines: { line: number; text: string }[];
}

/** A search's hits by file, the files the turn went on to open first. */
export function hitFiles(search: SearchObject): HitFile[] {
  const files = new Map<string, HitFile>();
  for (const hit of search.hits) {
    const file = files.get(hit.path) ?? { path: hit.path, name: basename(hit.path), folder: folderOf(hit.path), opened: search.opened.includes(hit.path), lines: [] };
    if (hit.line !== null) file.lines.push({ line: hit.line, text: hit.text });
    files.set(hit.path, file);
  }
  return [...files.values()].sort((a, b) => Number(b.opened) - Number(a.opened));
}

/** Whether two paths name one file, when either may be the other's tail: a search prints paths from where it ran. */
export function samePath(a: string, b: string): boolean {
  const parts = (path: string) =>
    path
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part && part !== ".");
  const [x, y] = [parts(a), parts(b)];
  const shared = Math.min(x.length, y.length);
  return shared > 0 && x.slice(-shared).join("/") === y.slice(-shared).join("/");
}

/** The words a search looked for, from its chip: each quoted term, or else each alternative of the pattern as written. */
export function hitTerms(chip: Pick<WorkChip, "label" | "detail">): string[] {
  const quoted = (text: string | undefined) => [...(text ?? "").matchAll(/“([^”]+)”/g)].map((match) => match[1]!);
  const terms = [...quoted(chip.label), ...quoted(chip.detail)];
  if (terms.length) return terms;
  return chip.label
    .replace(/^["'/]+|["'/]+$/g, "")
    .split("|")
    .map((term) => term.replace(/\\(.)/g, "$1"))
    .filter(Boolean);
}

export interface HitText {
  /** The line is words, a comment or a document's text, and reads as prose without its comment marks. */
  prose: boolean;
  parts: { text: string; match: boolean }[];
}

const PROSE_FILE = /\.(md|mdx|markdown|txt|rst)$/i;
/** What opens a comment line: `//`, `/*`, a block's `*`, `<!--`, and `#` or `--` before a space. */
const COMMENT = /^(?:\/\/+|\/\*+|\*+(?=\s|$)|<!--|#+(?=\s)|--(?=\s))\s*/;
const COMMENT_END = /\s*(?:\*+\/|-->)\s*$/;
/** How far into a line a match may sit before the words ahead of it are cut. */
const LEAD = 36;
const KEPT = 20;

function proseOf(path: string, text: string): string | null {
  if (PROSE_FILE.test(path)) return text;
  const mark = COMMENT.exec(text);
  const words = mark ? text.slice(mark[0].length).replace(COMMENT_END, "") : "";
  return words ? words : null;
}

/** The line from a few words before the match, so a match deep in a long line is not cut off the end. */
function around(text: string, at: number): string {
  if (at <= LEAD) return text;
  const space = text.lastIndexOf(" ", at - KEPT);
  return `…${text.slice(space > 0 ? space + 1 : at - KEPT)}`;
}

/** Which characters of a line any term covers, so terms that overlap mark one run: "const close" and "closeTab". */
function covered(line: string, terms: string[]): boolean[] {
  const mask = new Array<boolean>(line.length).fill(false);
  const lowered = line.toLowerCase();
  for (const term of terms.map((word) => word.toLowerCase()).filter(Boolean)) for (let at = lowered.indexOf(term); at >= 0; at = lowered.indexOf(term, at + 1)) mask.fill(true, at, at + term.length);
  return mask;
}

/** A matching line as it reads: prose or code, cut to the match, and split where a term matched. */
export function hitText(path: string, text: string, terms: string[]): HitText {
  const prose = proseOf(path, text);
  const whole = prose ?? text;
  const line = around(whole, covered(whole, terms).indexOf(true));
  const parts: HitText["parts"] = [];
  covered(line, terms).forEach((match, index) => {
    const last = parts[parts.length - 1];
    if (last && last.match === match) last.text += line[index];
    else parts.push({ text: line[index]!, match });
  });
  return { prose: prose !== null, parts };
}
