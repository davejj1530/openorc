import type { Block } from "./transcript";

/** A fork cutoff is the whole lead attempt, never a partial assistant message. */
export function teamForkReplyId(blocks: Block[]): string | null {
  const boundary = blocks.findLastIndex((block) => block.kind === "status" && block.id.startsWith("turn-") && block.tone === "ok");
  if (boundary < 0) return null;
  for (let index = boundary - 1; index >= 0; index--) {
    const block = blocks[index]!;
    if (block.kind === "message" && block.role === "assistant" && !block.streaming && block.text.trim() && !/^API Error:/.test(block.text)) return block.id;
  }
  return null;
}
