import { alignBlocks, type DiffBlock } from "@openorc/client";

/** A block of a suggested description as the phone marks it: as it was, new, reworded, or one the suggestion drops. */
export interface SuggestionBlock {
  kind: "same" | "added" | "changed" | "removed";
  text: string;
}

const FENCE = /^\s*(```|~~~)/;

/** A description's blocks: what blank lines part, a fenced code block kept whole. */
export function specBlocks(spec: string): DiffBlock[] {
  const blocks: string[][] = [];
  let fence: string | null = null;
  let open = false;
  for (const line of spec.split("\n")) {
    const mark = FENCE.exec(line)?.[1];
    if (fence === null && !line.trim()) {
      open = false;
      continue;
    }
    if (!open) blocks.push([]);
    open = true;
    blocks.at(-1)!.push(line);
    if (mark && fence === null) fence = mark;
    else if (mark === fence) fence = null;
  }
  return blocks.map((lines) => {
    const text = lines.join("\n");
    return { key: text.trim(), text };
  });
}

/** The suggested description block by block against the task's own, in the suggestion's order, a dropped block where it stood. */
export function suggestionBlocks(base: string, suggestion: string): SuggestionBlock[] {
  const before = specBlocks(base);
  const after = specBlocks(suggestion);
  return alignBlocks(before, after).map((op) => {
    if (op.kind === "removed") return { kind: op.kind, text: before[op.base]!.text };
    return { kind: op.kind, text: after[op.next]!.text };
  });
}
