import { actorPerson, type TeamChatAnswered, type TeamMessage, type TeamOrclingCall } from "@openorc/protocol";

/** Who wrote the answered message, as the reply names them. */
export const answeredName = (answered: TeamChatAnswered, self: string): string => {
  if (answered.orcling) return answered.orcling.name;
  return answered.person?.id === self ? "You" : (answered.person?.name ?? "Former member");
};

/** A message as a reply to it names it, before the server confirms the reply: its first words on one line. */
export function answeredOf(message: TeamMessage): TeamChatAnswered {
  const line = message.body.replace(/\s+/g, " ").trim();
  const orcling = message.actor.kind === "orcling" ? { name: message.actor.name } : null;
  return { id: message.id, seq: message.seq, person: actorPerson(message.actor), orcling, excerpt: line.length > 140 ? `${line.slice(0, 140).trimEnd()}…` : line, files: message.files.length };
}

/**
 * How the Orcling a message called is doing, as the line under that message says it: answering, or that it couldn't,
 * with a retry for its owner alone. Nothing for an answered call, whose answer follows, or a message that called none.
 */
export function teamChatCallLine(call: TeamOrclingCall | null, self: string): { words: string; failed: boolean; canRetry: boolean } | null {
  if (!call || call.state === "answered") return null;
  const answering = call.state === "pending" || call.state === "running";
  return { words: answering ? `${call.name} is answering…` : `${call.name} couldn't answer`, failed: !answering, canRetry: !answering && call.owner.id === self };
}
