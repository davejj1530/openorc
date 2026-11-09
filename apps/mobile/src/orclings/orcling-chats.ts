import { threadStatus, type ThreadStatus } from "@openorc/client";
import type { OrclingChatSummary } from "@openorc/protocol";
import { useRpc } from "../client";
import { plainPreview } from "./message-preview";

const NONE: OrclingChatSummary[] = [];

/**
 * The Mac's Orclings with their own conversations, oldest first. `supported` is false while the Mac has said nothing
 * yet, and stays false for a Mac too old to list them, which keeps the phone's Orcling screens out of sight.
 */
export function useOrclingChats(): { chats: OrclingChatSummary[]; supported: boolean } {
  const query = useRpc("orclings.chats", {});
  return { chats: query.data ?? NONE, supported: query.data !== undefined };
}

/** Where an Orcling's conversation stands: working, waiting on the person, failed, texts unread, or nothing. */
export const chatStatus = (chat: OrclingChatSummary): ThreadStatus | null => (chat.thread ? threadStatus(chat.thread) : null);

/** The conversation wants the person: it asks something, or texted since they last looked. */
export function needsYou(chat: OrclingChatSummary): boolean {
  const kind = chatStatus(chat)?.kind;
  return kind === "waiting" || kind === "unread" || kind === "failed";
}

/** Newest conversation first, as a texting app lists them; one that has said nothing yet keeps its place at the end. */
export const byRecent = (chats: readonly OrclingChatSummary[]): OrclingChatSummary[] => [...chats].sort((a, b) => (b.last?.createdAt ?? 0) - (a.last?.createdAt ?? 0));

/** The Orcling whose own conversation this is, if any. */
export const chatFor = (chats: readonly OrclingChatSummary[], threadId: string | undefined): OrclingChatSummary | null => (threadId && chats.find((chat) => chat.threadId === threadId)) || null;

/** What a row says of the newest message: the Orcling's words as plain text, the person's after "You:". */
export function lastLine(chat: OrclingChatSummary): string {
  const last = chat.last;
  if (!last) return "No messages yet";
  const text = plainPreview(last.text) || (last.attachments?.length ? "Sent an attachment" : "");
  return last.role === "user" ? `You: ${text}` : text;
}

/** When the newest message came: a time today, a weekday this week, else a short date. */
export function lastWhen(at: number, now = Date.now()): string {
  const date = new Date(at);
  const day = (ts: number) => new Date(ts).toDateString();
  if (day(at) === day(now)) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (day(at) === day(now - 86_400_000)) return "Yesterday";
  if (now - at < 6 * 86_400_000) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
