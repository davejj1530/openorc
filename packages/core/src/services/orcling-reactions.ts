import { listEvents, messageReactions, orclingMessages, runs as runRepo, type Db } from "@openorc/db";
import { chatBubbles, reactionEmoji, type MessageReaction } from "@openorc/protocol";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

interface SaidMessage {
  runId: string;
  messageId: string;
  text: string;
}

/** A message in an Orcling chat with who said it: an Orcling by id, or null for the person. */
interface ChatMessage extends SaidMessage {
  author: string | null;
}

/** Where a tapback lands: the bubble an Orcling reacts to. */
export interface ReactionSpot extends SaidMessage {
  part: number;
}

function messages(db: Db, runId: string): SaidMessage[] {
  return listEvents(db, runId, { kinds: ["message.completed"], newest: true, limit: 400 }).flatMap((event) =>
    event.type === "message.completed" ? [{ runId, messageId: event.messageId, text: event.text }] : [],
  );
}

/**
 * A chat's messages, newest first, each with who said it. An Orcling's words are its runs' replies, or a message it
 * sent into this chat; the person's are the rest of what was written here. Notes OpenOrc gave a turn are no one's.
 */
function* newestFirst(db: Db, threadId: string): Generator<ChatMessage> {
  const sentBy = new Map(orclingMessages.list(db, threadId).map((origin) => [origin.messageId, origin.fromOrclingId]));
  for (const run of runRepo.listForThread(db, threadId).reverse()) {
    const events = listEvents(db, run.id, { kinds: ["message.completed"], newest: true, limit: 400 });
    for (const event of events.reverse()) {
      if (event.type !== "message.completed" || !event.text.trim()) continue;
      const sender = sentBy.get(event.messageId);
      if (event.role === "assistant" && run.orclingId) yield { runId: run.id, messageId: event.messageId, text: event.text, author: run.orclingId };
      else if (sender) yield { runId: run.id, messageId: event.messageId, text: event.text, author: sender };
      else if (event.role === "user") yield { runId: run.id, messageId: event.messageId, text: event.text, author: null };
    }
  }
}

/** The newest message from someone in a chat, the person with null: its last bubble, the thing they said last. */
export function latestFrom(db: Db, threadId: string, author: string | null): ReactionSpot | null {
  for (const message of newestFirst(db, threadId)) {
    if (message.author !== author) continue;
    const bubbles = chatBubbles(message.text);
    const part = author === null ? 0 : Math.max(0, bubbles.length - 1);
    return { runId: message.runId, messageId: message.messageId, text: bubbles[part] ?? message.text, part };
  }
  return null;
}

/** Whether a run of this conversation said this message, so a reaction cannot land on another thread's. */
export function messageInThread(db: Db, threadId: string, runId: string, messageId: string): boolean {
  return runRepo.get(db, runId)?.threadId === threadId && messages(db, runId).some((message) => message.messageId === messageId);
}

function bubbleText(db: Db, reaction: MessageReaction): string {
  const message = messages(db, reaction.runId).find((candidate) => candidate.messageId === reaction.messageId);
  return message ? (chatBubbles(message.text)[reaction.part] ?? message.text) : "";
}

/** The person's reactions since the Orcling's last turn, told once, ahead of the next message it reads. */
export function reactionNote(db: Db, threadId: string): string {
  const heard = messageReactions.takeUnheard(db, threadId);
  if (!heard.length) return "";
  const lines = heard.map((reaction) => `- ${reactionEmoji[reaction.reaction]} on "${clip(flat(bubbleText(db, reaction)), 160)}"`);
  return ["(OpenOrc: since your last turn the person reacted to your messages. Take it in; mention it only if it matters.)", ...lines].join("\n");
}

/**
 * The tapbacks others left in a group since a time, for the Orcling catching up: who reacted with what, to whose words.
 * Its own are left out, since it knows them.
 */
export function reactionsSince(db: Db, threadId: string, since: number, self: string | null, names: (orclingId: string) => string | null): string[] {
  const left = messageReactions.list(db, threadId).filter((reaction) => reaction.at > since && reaction.orclingId !== self);
  if (!left.length) return [];
  const said = new Map([...newestFirst(db, threadId)].map((message) => [`${message.runId}|${message.messageId}`, message]));
  const who = (orclingId: string | null) => (orclingId === null ? "The person" : (names(orclingId) ?? "An Orcling"));
  const whose = (author: string | null) => {
    if (author === self) return "your";
    return author === null ? "the person's" : `${names(author) ?? "an Orcling"}'s`;
  };
  return left.slice(-8).flatMap((reaction) => {
    const message = said.get(`${reaction.runId}|${reaction.messageId}`);
    if (!message) return [];
    const bubble = chatBubbles(message.text)[reaction.part] ?? message.text;
    return [`${who(reaction.orclingId)} reacted ${reactionEmoji[reaction.reaction]} to ${whose(message.author)} "${clip(flat(bubble), 120)}"`];
  });
}
