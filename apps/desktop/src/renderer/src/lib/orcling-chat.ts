import { chatBubbles } from "@openorc/protocol";
import { startedWorkFromTool, taskIdFromTool, type Block } from "@openorc/client";

type Message = Extract<Block, { kind: "message" }>;

/**
 * An Orcling's own conversation as a chat shows it: what the person wrote, what the Orcling texted as one message per
 * paragraph, the cards that need the person (approvals, questions, work it started, errors), and the time between
 * stretches. Its tool calls, thoughts and turn statuses stay out of sight; the typing dots stand in for them.
 */
export type ChatRow =
  | { kind: "time"; id: string; at: number }
  | { kind: "mine"; id: string; block: Message }
  | { kind: "theirs"; id: string; block: Message; bubbles: string[] }
  | { kind: "card"; id: string; block: Block };

/** A gap this long between messages starts a new stretch, headed by its time. */
export const CHAT_STRETCH_MS = 60 * 60_000;

function card(block: Block): boolean {
  switch (block.kind) {
    case "approval":
      return true;
    case "tool":
      return Boolean(taskIdFromTool(block) || startedWorkFromTool(block));
    case "activity":
      return Boolean(block.recovery);
    case "status":
      return block.tone === "bad" && !/^(turn|session) /.test(block.text);
    case "message":
      return block.role === "system" || (block.role === "assistant" && /^API Error:/.test(block.text));
    case "thinking":
      return false;
  }
}

export function chatRows(blocks: readonly Block[]): ChatRow[] {
  const rows: ChatRow[] = [];
  let lastAt: number | null = null;
  const stamp = (block: Block) => {
    const at = block.at;
    if (at === undefined) return;
    if (lastAt === null || at - lastAt >= CHAT_STRETCH_MS) rows.push({ kind: "time", id: `time-${block.id}`, at });
    lastAt = at;
  };
  for (const block of blocks) {
    if (card(block)) {
      rows.push({ kind: "card", id: block.id, block });
      continue;
    }
    if (block.kind !== "message") continue;
    if (block.role === "user" && (block.text || block.attachments?.length)) {
      stamp(block);
      rows.push({ kind: "mine", id: block.id, block });
    } else if (block.role === "assistant" && !block.streaming) {
      const bubbles = chatBubbles(block.text);
      if (!bubbles.length) continue;
      stamp(block);
      rows.push({ kind: "theirs", id: block.id, block, bubbles });
    }
  }
  return rows;
}

/** How long the Orcling seems to type a message before it lands: longer for longer ones, never a wait. */
export function typingBeat(text: string): number {
  return Math.min(2000, Math.max(700, 450 + text.length * 22));
}

/** "Today 9:41 AM", "Yesterday 6:02 PM", "Mon 9 Nov, 9:41 AM": when a stretch of the chat began. */
export function stretchTime(at: number, now = Date.now()): string {
  const day = (ts: number) => new Date(ts).toDateString();
  const time = new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (day(at) === day(now)) return `Today ${time}`;
  if (day(at) === day(now - 86_400_000)) return `Yesterday ${time}`;
  return `${new Date(at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}
