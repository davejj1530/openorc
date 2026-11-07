import type { LineNote, LineSpan } from "@openorc/protocol";

export interface NoteSegment {
  start: number;
  end: number;
  /** Null for code no note covers, shown as it is. */
  note: LineNote | null;
}

/** Brackets, closing tags and blank lines that close what a note opened belong to that note's code. */
const closing = (line: string) => /^[\s()[\]{}<>;,.]*$/.test(line) || /^\s*<\/[\w.:-]*>[\s;,)}\]]*$/.test(line) || /^[\s)}\]]*:\s*(?:null|undefined|false)[\s;,)}\]]*$/.test(line);

/**
 * A stretch of the file as notes and their code. Each note's code is its own lines and the closing brackets after
 * them; code no note covers stands on its own without a note, never under the note above it. Blank lines at a
 * segment's edges, and code that is only blank, are left out.
 */
export function noteSegments(notes: readonly LineNote[], span: LineSpan, lines: readonly string[]): NoteSegment[] {
  const inside = notes.filter((note) => note.lines.start >= span.start && note.lines.start <= span.end);
  const last = Math.min(span.end, lines.length);
  const blank = (line: number) => !lines[line - 1]?.trim();
  const segments: NoteSegment[] = [];
  const plain = (from: number, to: number) => {
    let start = from;
    let end = to;
    while (start <= end && blank(start)) start++;
    while (end >= start && blank(end)) end--;
    if (start <= end) segments.push({ start, end, note: null });
  };
  let reached = span.start;
  inside.forEach((note, index) => {
    const next = inside[index + 1]?.lines.start ?? last + 1;
    plain(reached, note.lines.start - 1);
    let end = Math.min(Math.max(note.lines.end, note.lines.start), next - 1);
    while (end + 1 < next && closing(lines[end] ?? "")) end++;
    while (end > note.lines.start && blank(end)) end--;
    segments.push({ start: note.lines.start, end, note });
    reached = end + 1;
  });
  plain(reached, last);
  return segments;
}
