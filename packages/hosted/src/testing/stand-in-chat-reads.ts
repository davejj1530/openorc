import type { TeamChatRead } from "@openorc/protocol";
import { userOf } from "./stand-in-spaces.js";
import type { StandInChatRecord } from "./stand-in-chat.js";

type Reply = { status: number; body: unknown };
const TAG = /@\[user:([^\]\s]+)\]/g;
const key = (conversationId: string, who: string) => `${conversationId}\u0000${userOf(who)}`;

/** Bounded read places, as the server keeps them: per person, forward only, by a displayed message's sequence. */
export class StandInChatReads {
  readonly #seen = new Map<string, number>();

  /** Sets a person's place directly, as a fixture's starting state. */
  place(conversationId: string, who: string, seq: number): void {
    this.#seen.set(key(conversationId, who), seq);
  }

  read(record: StandInChatRecord, who: string): TeamChatRead | null {
    if (!record.conversation.members.some((person) => person.id === userOf(who))) return null;
    const seenSeq = this.#seen.get(key(record.conversation.id, who)) ?? 0;
    const later = record.messages.filter((message) => message.seq > seenSeq && message.actor.person?.id !== userOf(who));
    return {
      seenSeq,
      seenThroughMessageId: record.messages.find((message) => message.seq === seenSeq)?.id ?? null,
      unread: later.length,
      hasMention: later.some((message) => [...message.body.matchAll(TAG)].some((match) => match[1] === userOf(who))),
    };
  }

  seen(record: StandInChatRecord, who: string, body: unknown): Reply {
    const messageId = body && typeof body === "object" && "messageId" in body ? body.messageId : null;
    const message = record.messages.find((each) => each.id === messageId);
    if (!message) return { status: 400, body: { message: "That message isn't in this conversation." } };
    const now = this.read(record, who);
    if (!now) return { status: 403, body: { message: "Join this channel to keep your place in it." } };
    this.#seen.set(key(record.conversation.id, who), Math.max(now.seenSeq, message.seq));
    return { status: 200, body: this.read(record, who) };
  }

  /** The tagged people a message may name here: anyone in a public channel's organization, else its members. */
  refusal(record: StandInChatRecord, body: string, people: readonly { id: string }[]): Reply | null {
    const allowed = new Set((record.conversation.kind === "channel" && !record.conversation.private ? people : record.conversation.members).map((person) => person.id));
    return [...body.matchAll(TAG)].every((match) => allowed.has(match[1]!)) ? null : { status: 400, body: { message: "Only people in this conversation can be mentioned here." } };
  }

  unreadSpaces(records: readonly StandInChatRecord[], who: string, usable: (spaceId: string) => boolean): Reply {
    const spaces = [...new Set(records.filter((record) => usable(record.spaceId) && (this.read(record, who)?.unread ?? 0) > 0).map((record) => record.spaceId))];
    return { status: 200, body: { spaces: spaces.sort().map((spaceId) => ({ spaceId })) } };
  }
}
