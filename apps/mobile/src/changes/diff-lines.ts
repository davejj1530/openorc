import { drawnLine, type MonoMetrics } from "../thread/mono-lines";

/** One line of a file's diff as the phone draws it: a hunk's header, an added, removed or kept line, or git's note. */
export interface DiffRow {
  kind: "hunk" | "add" | "del" | "context" | "note";
  /** The line as git printed it, its +, - or space included. */
  text: string;
  /** The new side's line number for added and kept lines, the old side's for removed ones. */
  number: number | null;
}

/** A run of rows drawn on one tint: added, removed, or a hunk's header. */
export interface DiffRun {
  kind: "add" | "del" | "hunk";
  start: number;
  length: number;
}

/** Rows in one Text's worth: the gutter's numbers and the code, line for line, each line's kind, and the tints behind the code. */
export interface DiffChunk {
  gutter: string;
  code: string;
  kinds: DiffRow["kind"][];
  runs: DiffRun[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const kinds: Record<string, DiffRow["kind"]> = { "+": "add", "-": "del", " ": "context", "\\": "note" };

/** A unified diff's hunks as rows; anything before the first hunk (git's own headers) is dropped. */
export function diffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let old = 0;
  let next = 0;
  let inHunk = false;
  for (const text of patch.split("\n")) {
    const hunk = HUNK.exec(text);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text, number: null });
      continue;
    }
    const kind = inHunk ? kinds[text[0] ?? ""] : undefined;
    if (!kind) continue;
    if (kind === "del") rows.push({ kind, text, number: old++ });
    else if (kind === "note") rows.push({ kind, text, number: null });
    else {
      rows.push({ kind, text, number: next++ });
      if (kind === "context") old++;
    }
  }
  return rows;
}

function runsOf(rows: DiffRow[]): DiffRun[] {
  const runs: DiffRun[] = [];
  rows.forEach((row, index) => {
    if (row.kind === "context" || row.kind === "note") return;
    const last = runs.at(-1);
    if (last && last.kind === row.kind && last.start + last.length === index) last.length++;
    else runs.push({ kind: row.kind, start: index, length: 1 });
  });
  return runs;
}

/** The rows in chunks of `chunkLines`, each line cut at the drawn width as the tool sheet cuts output. */
export function diffChunks(rows: DiffRow[], { chunkLines, lineChars }: Pick<MonoMetrics, "chunkLines" | "lineChars">): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  for (let start = 0; start < rows.length; start += chunkLines) {
    const part = rows.slice(start, start + chunkLines);
    chunks.push({
      gutter: part.map((row) => (row.number === null ? "" : String(row.number))).join("\n"),
      code: part.map((row) => drawnLine(row.text, lineChars)).join("\n"),
      kinds: part.map((row) => row.kind),
      runs: runsOf(part),
    });
  }
  return chunks;
}
