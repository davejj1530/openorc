import { CHAT_STRETCH_MS } from "@openorc/client";
import type { TeamMessage } from "@openorc/protocol";

/**
 * One row of a team conversation on the phone, as the desktop's transcript reads: a day and time over each stretch, the
 * New messages line at the reader's place, the reader's own message on the right, and another's on the left, with the
 * name over the first of a run and the face beside its last. `gap` is the space above.
 */
export type ChatItem = { key: string; gap: number } & (
  { kind: "time"; at: number } | { kind: "new" } | { kind: "mine"; message: TeamMessage } | { kind: "theirs"; message: TeamMessage; first: boolean; last: boolean }
);

/** Messages of one run sit this close; anything else stands apart. */
const IN_RUN = 3;
const APART = 14;

/** Who wrote a message, as a key: a person by id, an Orcling by the call it answered, a former member as one. */
export const actorKey = (message: TeamMessage): string => (message.actor.kind === "orcling" ? `orcling:${message.actor.callId}` : `person:${message.actor.person?.id ?? ""}`);

const authorId = (message: TeamMessage): string | null => (message.actor.kind === "person" ? (message.actor.person?.id ?? null) : null);

/**
 * The conversation's messages as rows. `newFrom` is the reader's place as the conversation opened: the line stands over
 * the first message after it that someone else wrote, and null draws none.
 */
export function chatItems(messages: readonly TeamMessage[], self: string, newFrom: number | null): ChatItem[] {
  const items: ChatItem[] = [];
  const firstNew = newFrom === null ? undefined : messages.find((message) => message.seq > newFrom && authorId(message) !== self);
  let previous: TeamMessage | null = null;
  for (const message of messages) {
    const at = Date.parse(message.createdAt);
    const stretch = !previous || at - Date.parse(previous.createdAt) >= CHAT_STRETCH_MS;
    if (stretch) items.push({ kind: "time", key: `time:${message.id}`, gap: items.length ? 20 : 8, at });
    if (message === firstNew) items.push({ kind: "new", key: "new", gap: APART });
    const continues = !stretch && message !== firstNew && previous !== null && actorKey(previous) === actorKey(message);
    if (authorId(message) === self) items.push({ kind: "mine", key: message.id, gap: continues ? IN_RUN : APART, message });
    else {
      const before = items.at(-1);
      if (continues && before?.kind === "theirs") before.last = false;
      items.push({ kind: "theirs", key: message.id, gap: continues ? IN_RUN : APART, message, first: !continues, last: true });
    }
    previous = message;
  }
  return items;
}
