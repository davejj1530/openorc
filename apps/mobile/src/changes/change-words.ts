import { fileCount, formatBytes } from "@openorc/client";
import type { FileDiff, FileDiffBody, WorkspaceChanges } from "@openorc/protocol";

/*
 * The Changes screen's words: the desktop's where it has them, with the composer chip's minus sign.
 */

const count = (n: number) => n.toLocaleString("en-US");
const plus = (n: number) => `+${count(n)}`;
const minus = (n: number) => `−${count(n)}`;

/** A change's line counts, a side only when it has lines: "+2", "−1" or both; null when it has none. */
export interface LineCounts {
  insertions: string | null;
  deletions: string | null;
}

export function lineCounts(insertions: number, deletions: number): LineCounts | null {
  if (!insertions && !deletions) return null;
  return { insertions: insertions ? plus(insertions) : null, deletions: deletions ? minus(deletions) : null };
}

/** "+2 −1", "+2" or "−1", as a line reads it and VoiceOver says it. */
export const countsText = (counts: LineCounts): string => [counts.insertions, counts.deletions].filter(Boolean).join(" ");

/** "3 files · +42 −7" under the title, a side only with lines; nothing for no files. */
export function changesLine(totals: WorkspaceChanges["totals"]): string | null {
  if (!totals.files) return null;
  const counts = lineCounts(totals.insertions, totals.deletions);
  return counts ? `${fileCount(totals.files)} · ${countsText(counts)}` : fileCount(totals.files);
}

export type FileTrailing = ({ kind: "stat" } & LineCounts) | { kind: "word"; text: string };

/** What ends a file's row: its line counts, "Binary", or a large file's size. A fifo, a socket or an empty change ends with nothing. */
export function fileTrailing(body: FileDiffBody): FileTrailing | null {
  switch (body.kind) {
    case "text": {
      const counts = lineCounts(body.insertions, body.deletions);
      return counts ? { kind: "stat", ...counts } : null;
    }
    case "binary":
      return { kind: "word", text: "Binary" };
    case "omitted":
      return body.reason === "large" && body.bytes !== null ? { kind: "word", text: formatBytes(body.bytes) } : null;
  }
}

export const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** The diff's faint line: the folder and counts, or what happened to the file as a whole. */
export function diffLine(diff: Pick<FileDiff, "path" | "oldPath" | "status" | "body">): string {
  if (diff.status === "renamed" && diff.oldPath) return `Renamed from ${diff.oldPath}`;
  if (diff.status === "added" || diff.status === "untracked") return "New file";
  if (diff.status === "deleted") return "Deleted";
  const counts = diff.body.kind === "text" ? lineCounts(diff.body.insertions, diff.body.deletions) : null;
  return [folderOf(diff.path), counts && countsText(counts)].filter(Boolean).join(" · ");
}

/** Why a diff draws no lines, in place of its body; null when it has lines. */
export function omittedText(body: FileDiffBody): string | null {
  if (body.kind === "binary") return "Binary file";
  if (body.kind === "text") return null;
  if (body.reason === "special") return "Not a regular file";
  return body.bytes === null ? "Too large to show" : `Too large to show (${formatBytes(body.bytes)})`;
}

/** "5,000 of 23,410 lines" at the end of a diff cut at the cap. */
export const cutText = (cut: NonNullable<FileDiff["cut"]>): string => `${count(cut.shownLines)} of ${count(cut.totalLines)} lines`;
