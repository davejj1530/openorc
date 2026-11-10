import { chatBubbles, type Visualization } from "@openorc/protocol";
import { startedWorkFromTool, taskIdFromTool } from "./task-progress.js";
import type { Block } from "./transcript.js";
import { visualizationFromTool } from "./visualization.js";

type Message = Extract<Block, { kind: "message" }>;
type Tool = Extract<Block, { kind: "tool" }>;

/**
 * An Orcling's own conversation as a chat shows it: what the person wrote, what the Orcling texted as one message per
 * paragraph, what it drew for them, the cards that need the person (approvals, questions, work it started, errors), and
 * the time between stretches. Its other tool calls, thoughts and turn statuses stay out of sight; the typing dots stand
 * in for them.
 */
export type ChatRow =
  | { kind: "time"; id: string; at: number }
  | { kind: "mine"; id: string; block: Message }
  | {
      kind: "theirs";
      id: string;
      block: Message;
      bubbles: string[];
      /** The Orcling who sent it when it came from another Orcling; otherwise whoever spoke in its run. */
      from?: string;
      /** Who it was sent to, when the Orcling texted another Orcling or opened a group. */
      to?: string;
    }
  | { kind: "card"; id: string; block: Block }
  /** Something the Orcling drew for the person, such as a diagram or a step-through, shown as itself. */
  | { kind: "visualization"; id: string; block: Tool; visualization: Visualization };

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

const names = (list: string[]) => new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(list);

/** A message an Orcling sent another Orcling, or the words it opened a group with, as its tool call carries them. */
function sentMessage(block: Tool): { to: string; text: string } | null {
  const input = block.input as { to?: unknown; with?: unknown; text?: unknown } | null;
  if (block.isError || typeof input?.text !== "string") return null;
  if (/orcling_message$/.test(block.name) && typeof input.to === "string") return { to: input.to, text: input.text };
  if (/orcling_group_start$/.test(block.name) && Array.isArray(input.with)) return { to: names(input.with.map(String)), text: input.text };
  return null;
}

/** A message the Orcling sent another Orcling or a new group, as its own bubbles there. */
function sentRow(block: Tool): Extract<ChatRow, { kind: "theirs" }> | null {
  const sent = sentMessage(block);
  if (!sent) return null;
  const message: Message = {
    id: block.id,
    kind: "message",
    role: "assistant",
    text: sent.text,
    streaming: false,
    ...(block.at === undefined ? {} : { at: block.at }),
    ...(block.runId ? { runId: block.runId } : {}),
  };
  return { kind: "theirs", id: block.id, block: message, bubbles: chatBubbles(sent.text), to: sent.to };
}

/** A tool call that shows in the chat: a message the Orcling sent another, or something it drew for the person. */
function toolRow(block: Tool): ChatRow | null {
  const sent = sentRow(block);
  if (sent) return sent;
  const visualization = visualizationFromTool(block);
  return visualization ? { kind: "visualization", id: block.id, block, visualization } : null;
}

/** A block's row in the chat, and whether it heads a stretch of time; null for what stays out of sight. */
function rowOf(block: Block, origins: ReadonlyMap<string, string>): { row: ChatRow; timed: boolean } | null {
  const own = block.kind === "tool" ? toolRow(block) : null;
  if (own) return { row: own, timed: true };
  const from = block.kind === "message" && block.role === "system" ? origins.get(block.id) : undefined;
  if (from && block.kind === "message") return { row: { kind: "theirs", id: block.id, block, bubbles: chatBubbles(block.text), from }, timed: true };
  if (card(block)) return { row: { kind: "card", id: block.id, block }, timed: false };
  if (block.kind !== "message") return null;
  if (block.role === "user") return block.text || block.attachments?.length ? { row: { kind: "mine", id: block.id, block }, timed: true } : null;
  if (block.role !== "assistant" || block.streaming) return null;
  const bubbles = chatBubbles(block.text);
  return bubbles.length ? { row: { kind: "theirs", id: block.id, block, bubbles }, timed: true } : null;
}

/**
 * The chat's rows. `origins` names the Orcling behind each message another Orcling sent here, by message id, so its
 * words show as that Orcling's rather than as a notice.
 */
export function chatRows(blocks: readonly Block[], origins: ReadonlyMap<string, string> = new Map()): ChatRow[] {
  const rows: ChatRow[] = [];
  let lastAt: number | null = null;
  for (const block of blocks) {
    const found = rowOf(block, origins);
    if (!found) continue;
    if (found.timed && block.at !== undefined) {
      if (lastAt === null || block.at - lastAt >= CHAT_STRETCH_MS) rows.push({ kind: "time", id: `time-${block.id}`, at: block.at });
      lastAt = block.at;
    }
    rows.push(found.row);
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
