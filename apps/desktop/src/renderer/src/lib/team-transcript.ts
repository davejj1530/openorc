import type { TeamChatEntry } from "@openorc/protocol";
import type { Block } from "./transcript";
import { mentionNameText } from "./mention-names";

/** Add missing addressees; an ID mention rendered as a name already addresses them. */
export function teamChatText(entry: TeamChatEntry, names?: ReadonlyMap<string, string>): string {
  if (/(?:^|\s)@everyone\b/i.test(entry.text)) return entry.text;
  const visible = names ? mentionNameText(names)(entry.text) : entry.text;
  const missing = entry.to.filter((recipient) => {
    const escaped = recipient.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const aliases = recipient.actorId === "lead" ? `${escaped}|lead` : escaped;
    return !new RegExp(`(?:^|[^\\p{L}\\p{N}_@])@(?:${aliases})(?![\\p{L}\\p{N}_-])`, "iu").test(visible);
  });
  return [...missing.map((recipient) => `@${recipient.name}`), entry.text].join(" ");
}

/** Work stays available in order; replies and anything requiring the user stay in the room. */
export function teamTranscriptParts(blocks: Block[], live: boolean, ambient = false) {
  const lastReply = blocks.findLastIndex((block) => block.kind === "message" && block.role === "assistant");
  const finishedReply = !ambient && !live && lastReply >= 0 && !blocks.slice(lastReply + 1).some((block) => ["tool", "thinking", "activity"].includes(block.kind));
  const visible: Block[] = [];
  const work: Block[] = [];
  blocks.forEach((block, index) => {
    if (
      (block.kind === "approval" && (!block.decision || block.decision === "deny")) ||
      (block.kind === "status" && block.tone === "bad") ||
      (block.kind === "message" && (/^API Error:/.test(block.text) || (finishedReply && index === lastReply)))
    )
      visible.push(block);
    else if (block.kind !== "status" && !(block.kind === "approval" && block.decision && block.decision !== "deny")) work.push(block);
  });
  // An uneventful background read has a receipt, not a conversation row.
  if (ambient && !work.some((block) => block.kind === "tool" || (block.kind === "activity" && block.status === "error"))) return { visible, work: [] };
  return { visible, work };
}
