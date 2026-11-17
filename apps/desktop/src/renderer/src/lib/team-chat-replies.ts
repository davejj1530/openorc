import type { TeamChatAnswered, TeamChatPerson, TeamMessage } from "@openorc/protocol";
import { personTagText } from "./rehype-person-tags";

/** Who wrote the answered message, as the reply names them. */
export const answeredName = (answered: TeamChatAnswered, self: string): string => (answered.person?.id === self ? "You" : (answered.person?.name ?? "Former member"));

/** The answered message's first words without Markdown marks, or what it carried when it had no words. */
export function answeredWords(answered: TeamChatAnswered, people: readonly TeamChatPerson[]): string {
  const words = personTagText(answered.excerpt, (id) => people.find((person) => person.id === id)?.name)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`|\*\*|__|~~/g, "")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
    .trim();
  if (words) return words;
  return answered.files === 1 ? "1 file" : `${answered.files} files`;
}

/** A message as a reply to it names it, before the server confirms the reply: its first words on one line. */
export function answeredOf(message: TeamMessage): TeamChatAnswered {
  const line = message.body.replace(/\s+/g, " ").trim();
  return { id: message.id, seq: message.seq, person: message.actor.person, excerpt: line.length > 140 ? `${line.slice(0, 140).trimEnd()}…` : line, files: message.files.length };
}
