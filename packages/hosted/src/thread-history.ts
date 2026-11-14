import { HOSTED_REASONS, type ThreadMessage } from "@openorc/protocol";
import { Refused } from "./session.js";
import type { HeardRow, Threads } from "./threads.js";
import { toAppEvent } from "./translate.js";
import { ROUTES, type WireEvent } from "./wire.js";

const PAGE_SIZE = 1000;
const PREVIEW_CHARS = 280;
const previews = new WeakMap<HeardRow, { head: number; message: ThreadMessage | null }>();

function latestMessage(threadId: string, events: WireEvent[]): ThreadMessage | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = toAppEvent(threadId, events[index]!);
    if (event.type !== "message.completed" || event.role === "system" || !event.text.trim()) continue;
    return { id: event.messageId, role: event.role, text: event.text.slice(0, PREVIEW_CHARS), createdAt: event.ts, ...(event.attachments && { attachments: event.attachments }) };
  }
  return null;
}

/** A bounded tail read on demand. Replaced or revoked rows cannot reuse an earlier account's preview. */
export async function lastMessage(threads: Threads, { id }: { id: string }): Promise<ThreadMessage | null> {
  const row = threads.row(id);
  const cached = previews.get(row);
  if (cached?.head === row.head) return cached.message;
  const page = await threads.on(id).request(ROUTES.events(id, { before: row.head + 1 }, PAGE_SIZE));
  const message = latestMessage(id, page.events);
  if (!message && page.events.length === PAGE_SIZE) throw new Refused(HOSTED_REASONS.search);
  previews.set(row, { head: row.head, message });
  return message;
}
