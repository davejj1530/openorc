import type { TeamChatAnswered, TeamChatPerson } from "@openorc/protocol";
import { personTagText } from "./rehype-person-tags";

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
