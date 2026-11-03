import type { WalkthroughBlock } from "@openorc/protocol";

export type WalkthroughSegment = { kind: "block"; block: WalkthroughBlock } | { kind: "code"; start: number; end: number };

/** The file from top to bottom: every block, and the code between blocks, trimmed of blank lines and left out when blank. */
export function walkthroughSegments(blocks: readonly WalkthroughBlock[], lines: readonly string[]): WalkthroughSegment[] {
  const segments: WalkthroughSegment[] = [];
  const blank = (line: number) => !lines[line - 1]?.trim();
  const code = (from: number, to: number) => {
    let start = from;
    let end = Math.min(to, lines.length);
    while (start <= end && blank(start)) start++;
    while (end >= start && blank(end)) end--;
    if (start <= end) segments.push({ kind: "code", start, end });
  };
  let next = 1;
  for (const block of blocks) {
    code(next, block.lines.start - 1);
    segments.push({ kind: "block", block });
    next = Math.max(next, block.lines.end + 1);
  }
  code(next, lines.length);
  return segments;
}
