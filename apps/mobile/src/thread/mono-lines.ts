import type { MatchGroup } from "@openorc/client";

/** Lines shown until the reader asks for all of them. */
const SHOWN_LINES = 200;
/**
 * Each native Text draws its whole frame into one bitmap, so long output is drawn as a stack of Texts, and only the
 * ones near the screen draw at all. At the default text size one holds 50 lines of 400 characters (1000 by 2880 pt),
 * so one long line (minified JSON, a progress bar) cannot make it too wide to draw either; a larger size fits fewer.
 */
const CHUNK_LINES = 50;
const LINE_CHARS = 400;
/** Characters iOS text layout starts a new line at, besides a line feed and a carriage return. */
const BREAKS = /[\v\f\u0085\u2028\u2029]/g;
/** A terminal's tab stops, every 8 columns. */
const TAB = 8;

/**
 * How the sheet's monospace text measures at the reader's text size (`fontScale`, from the iOS Text Size setting): a
 * line of 12 pt JetBrains Mono, which advances 0.6 em, on 20 pt lines, both scaled.
 */
export function monoMetrics(fontScale: number) {
  const line = 20 * fontScale;
  const chunkLines = Math.max(1, Math.floor(CHUNK_LINES / fontScale));
  return { line, char: 7.2 * fontScale, chunkLines, chunkHeight: chunkLines * line, lineChars: Math.max(2, Math.floor(LINE_CHARS / fontScale)) };
}

export type MonoMetrics = ReturnType<typeof monoMetrics>;

/**
 * Tabs as a terminal spaces them. iOS sets its own tab stops 28 pt apart whatever the text size, and starts a new line
 * past the last one, so `gh pr list` output would draw each line as two or three.
 */
function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  const [first = "", ...rest] = line.split("\t");
  return rest.reduce((out, part) => out + " ".repeat(TAB - (out.length % TAB)) + part, first);
}

/** One line as a terminal leaves it, on one drawn line: a carriage return goes back to the start and draws over it. */
export function drawnLine(line: string, lineChars: number): string {
  const ended = line.replace(/\r+$/, "");
  const last = expandTabs(ended.slice(ended.lastIndexOf("\r") + 1));
  return (last.length > lineChars ? `${last.slice(0, lineChars - 1)}…` : last).replace(BREAKS, " ");
}

/**
 * Monospace text as the tool sheet draws it: its lines in Text-sized groups, how many lines there are in all, and how
 * many characters the widest line shown has.
 */
export function monoLines(text: string, all: boolean, { chunkLines, lineChars }: MonoMetrics): { chunks: string[][]; total: number; columns: number } {
  const lines = text.split("\n");
  const shown = (all ? lines : lines.slice(0, SHOWN_LINES)).map((line) => drawnLine(line, lineChars));
  const chunks: string[][] = [];
  for (let start = 0; start < shown.length; start += chunkLines) chunks.push(shown.slice(start, start + chunkLines));
  return { chunks, total: lines.length, columns: shown.reduce((widest, line) => Math.max(widest, line.length), 0) };
}

/**
 * The chunks to draw, first to last (none when last is below first): those within half a screen of the part of the
 * sheet on screen. `offset` is where the first chunk sits in the sheet, unknown until measured; until then the lines
 * draw as if the sheet were at its top.
 */
export function chunksInView(view: { top: number; height: number }, offset: number | null, chunks: number, chunkHeight: number): [number, number] {
  const top = (offset === null ? 0 : view.top - offset) - view.height / 2;
  const bottom = top + view.height * 2;
  const first = Math.min(chunks - 1, Math.max(0, Math.floor(top / chunkHeight)));
  const last = Math.max(-1, Math.min(chunks - 1, Math.ceil(bottom / chunkHeight) - 1));
  return [first, last];
}

/**
 * Search results as one block of lines, the way `rg --heading` prints them: each file's path, then its lines by number,
 * a blank line between files. `paths` holds the index of each path line.
 */
export function matchLines(groups: MatchGroup[]): { text: string; paths: Set<number> } {
  const lines: string[] = [];
  const paths = new Set<number>();
  groups.forEach((group, index) => {
    if (index) lines.push("");
    paths.add(lines.length);
    lines.push(group.path, ...group.lines.map((line) => (line.line === null ? line.text : `${line.line}  ${line.text}`)));
  });
  return { text: lines.join("\n"), paths };
}
