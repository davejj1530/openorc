import { listEvents, messageReactions, runs as runRepo, type Db } from "@openorc/db";
import { chatBubbles, reactionEmoji, type MessageReaction } from "@openorc/protocol";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

interface SaidMessage {
  runId: string;
  messageId: string;
  text: string;
}

function messages(db: Db, runId: string): SaidMessage[] {
  return listEvents(db, runId, { kinds: ["message.completed"], newest: true, limit: 400 }).flatMap((event) =>
    event.type === "message.completed" ? [{ runId, messageId: event.messageId, text: event.text, role: event.role }] : [],
  );
}

/** The person's newest message in a conversation, which an Orcling's reaction goes on. */
export function latestPersonMessage(db: Db, threadId: string): SaidMessage | null {
  for (const run of runRepo.listForThread(db, threadId).reverse()) {
    const found = listEvents(db, run.id, { kinds: ["message.completed"], newest: true, limit: 400 }).findLast((event) => event.type === "message.completed" && event.role === "user");
    if (found?.type === "message.completed") return { runId: run.id, messageId: found.messageId, text: found.text };
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
