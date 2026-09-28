import type { ReviewComment } from "@openorc/protocol";

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
