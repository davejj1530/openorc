import type { ThreadNote } from "@openorc/protocol";
import type { Block } from "./transcript.js";

/**
 * Where a cloud thread's notes stand among its work. A note was stored when the thread's log reached its
 * `afterEventSeq`; it follows the block made by the latest event at or before that, so a note posted while a reply
 * streamed stays after that reply rather than moving to the end. Notes of one place keep their own order. A note from
 * before every loaded block stands at the top.
 */
export function placeNotes(blocks: readonly Block[], notes: readonly ThreadNote[]): { top: ThreadNote[]; after: Map<string, ThreadNote[]> } {
  const anchors = blocks.filter((block): block is Block & { seq: number } => block.seq !== undefined).sort((a, b) => a.seq - b.seq);
  const top: ThreadNote[] = [];
  const after = new Map<string, ThreadNote[]>();
  for (const note of [...notes].sort((a, b) => a.afterEventSeq - b.afterEventSeq || a.seq - b.seq)) {
    const anchor = anchors.findLast((block) => block.seq <= note.afterEventSeq);
    if (anchor) after.set(anchor.id, [...(after.get(anchor.id) ?? []), note]);
    else top.push(note);
  }
  return { top, after };
}
