import type { ReviewComment } from "./domain.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export type DiffSide = "old" | "new";

/** A line as the viewer addresses it: the removed ("old") or current ("new") side, and that side's number. */
export interface DiffLine {
  line: number;
  side: DiffSide;
}

/** Where a comment points: one line, or a range that ends on `line`, as GitHub's start_line/line. */
export interface CommentAnchor {
  startLine: number | null;
  startSide: DiffSide | null;
  line: number;
  side: DiffSide;
  /** What the commented lines say, one per line. */
  lineText: string;
}

/** One row of a single file's unified diff, in display order. */
interface DiffRow {
  hunk: number;
  old: number | null;
  new: number | null;
  text: string;
}

/** One file's part of a unified diff and the path it changes, the new name for a rename. */
export interface PatchFile {
  path: string;
  chunk: string;
}

/** A patch split per file, in the order the diff lists them. */
export function patchFiles(patch: string): PatchFile[] {
  const parts = patch.split(/^(?=diff --git )/m).filter((part) => part.trim().length > 0);
  return parts.map((chunk) => ({ path: changedPath(chunk) ?? "file", chunk }));
}

const QUOTED = /^"(?:[^"\\]|\\.)*"/;
const ESCAPES: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r" };

/**
 * A name as Git prints it in a diff. One with unusual characters comes in double quotes with C escapes, and each byte
 * of a non-ASCII character as three octal digits. An unquoted one containing a space ends with a tab.
 */
function gitName(text: string): string {
  const quoted = QUOTED.exec(text)?.[0];
  if (quoted === undefined) return text.replace(/\t$/, "");
  // Rewritten as percent-encoded UTF-8, which decodeURIComponent turns back into text in any environment.
  const encoded = quoted.slice(1, -1).replace(/\\([0-7]{3})|\\(.)|[^\\]+/gsu, (run, octal?: string, escaped?: string) => {
    if (octal !== undefined) return `%${parseInt(octal, 8).toString(16).padStart(2, "0")}`;
    return encodeURIComponent(escaped === undefined ? run : (ESCAPES[escaped] ?? escaped));
  });
  try {
    return decodeURIComponent(encoded);
  } catch {
    // Not UTF-8: the name stays as Git printed it.
    return text;
  }
}

/** The name on one side of a diff without Git's a/ or b/ prefix; null for /dev/null, the side of an added or deleted file. */
function sideName(text: string | undefined, prefix: "a/" | "b/" | "" = ""): string | null {
  if (text === undefined || text === "/dev/null") return null;
  const name = gitName(text);
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** The two names a `diff --git` line gives, either of them quoted. Unquoted names that contain " b/" can't be told apart. */
function headerNames(line: string): [string, string] | null {
  const rest = line.slice("diff --git ".length);
  const first = QUOTED.exec(rest)?.[0] ?? /^a\/.*?(?= "?b\/)/.exec(rest)?.[0];
  if (first === undefined) return null;
  return [first, rest.slice(first.length + 1)];
}

/**
 * The path one file's part of a diff changes: its new name, or its old one when it was deleted. Only the lines before
 * the first hunk are read, since a changed line can look like a header.
 */
function changedPath(chunk: string): string | null {
  const header = chunk.split(/^@@ /m, 1)[0]!;
  const line = (pattern: RegExp) => pattern.exec(header)?.[1];
  const names = headerNames(header.split("\n", 1)[0]!);
  return sideName(line(/^\+\+\+ (.+)$/m), "b/") ?? sideName(line(/^--- (.+)$/m), "a/") ?? sideName(line(/^(?:rename|copy) to (.+)$/m)) ?? sideName(names?.[1], "b/") ?? sideName(names?.[0], "a/");
}

function diffRows(chunk: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let hunk = -1;
  let oldLine = 0;
  let newLine = 0;
  for (const row of chunk.split("\n")) {
    const header = HUNK_HEADER.exec(row);
    if (header) {
      hunk += 1;
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (hunk < 0) continue;
    const marker = row[0];
    const text = row.slice(1);
    if (marker === " ") rows.push({ hunk, old: oldLine++, new: newLine++, text });
    else if (marker === "-") rows.push({ hunk, old: oldLine++, new: null, text });
    else if (marker === "+") rows.push({ hunk, old: null, new: newLine++, text });
  }
  return rows;
}

function rowIndex(rows: DiffRow[], point: DiffLine): number {
  return rows.findIndex((row) => (point.side === "old" ? row.old : row.new) === point.line);
}

/** A row reached by clamping keeps the current side when it has one. */
function pointOf(row: DiffRow, preferred?: DiffLine): DiffLine {
  if (preferred && (preferred.side === "old" ? row.old : row.new) === preferred.line) return preferred;
  return row.new !== null ? { line: row.new, side: "new" } : { line: row.old!, side: "old" };
}

/**
 * The comment a click or drag asks for, from where the pointer went down to
 * where it came up. The range reads top to bottom whichever way it was
 * dragged, and stops at the edge of the hunk it started in, as a pull request
 * review does. Null when the starting line is not in this diff.
 */
export function commentAnchor(chunk: string, from: DiffLine, to: DiffLine): CommentAnchor | null {
  const rows = diffRows(chunk);
  const anchor = rowIndex(rows, from);
  if (anchor < 0) return null;
  const hunk = rows[anchor]!.hunk;
  let reach = rowIndex(rows, to);
  if (reach < 0) reach = anchor;
  if (rows[reach]!.hunk !== hunk) {
    const inHunk = rows.flatMap((row, index) => (row.hunk === hunk ? [index] : []));
    reach = reach > anchor ? inHunk.at(-1)! : inHunk[0]!;
  }
  const [top, bottom] = anchor <= reach ? [anchor, reach] : [reach, anchor];
  const first = pointOf(rows[top]!, top === anchor ? from : to);
  const last = pointOf(rows[bottom]!, bottom === anchor ? from : to);
  const lineText = rows
    .slice(top, bottom + 1)
    .map((row) => row.text)
    .join("\n");
  if (top === bottom) return { startLine: null, startSide: null, line: last.line, side: last.side, lineText };
  return { startLine: first.line, startSide: first.side, line: last.line, side: last.side, lineText };
}

/** What a comment's lines say in this diff now, or null when they are no longer all in one hunk of it. */
function commentedText(chunk: string, comment: Pick<ReviewComment, "startLine" | "startSide" | "line" | "side">): string | null {
  if (comment.line === null || comment.side === null) return null;
  const rows = diffRows(chunk);
  const last = rowIndex(rows, { line: comment.line, side: comment.side });
  if (last < 0) return null;
  if (comment.startLine === null || comment.startSide === null) return rows[last]!.text;
  const first = rowIndex(rows, { line: comment.startLine, side: comment.startSide });
  if (first < 0 || first > last || rows[first]!.hunk !== rows[last]!.hunk) return null;
  return rows
    .slice(first, last + 1)
    .map((row) => row.text)
    .join("\n");
}

/**
 * A comment whose lines now say something else, or are no longer in the diff.
 * Comments without recorded text cannot be checked and stay where they are.
 */
export function isOutdated(comment: Pick<ReviewComment, "startLine" | "startSide" | "line" | "side" | "lineText">, chunk: string): boolean {
  if (comment.line === null || comment.lineText === null) return false;
  return commentedText(chunk, comment) !== comment.lineText;
}
