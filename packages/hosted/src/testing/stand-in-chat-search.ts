import { actorPerson, type TeamChatSearch } from "@openorc/protocol";
import type { StandInChatRecord } from "./stand-in-chat.js";

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

/** The server's search, small: every word, the last as a prefix, in the readable conversations given, newest first, tags read as names. */
export function standInSearch(readable: StandInChatRecord[], q: string, nameOf: (userId: string) => string | undefined): TeamChatSearch {
  const terms = wordsOf(q);
  if (!terms.length) return { hits: [], more: false };
  const matches = (word: string, term: string, last: boolean) => (last ? word.startsWith(term) : word === term);
  const hits = readable
    .flatMap((record) => record.messages)
    .filter((message) => {
      const words = wordsOf(message.body);
      return terms.every((term, at) => words.some((word) => matches(word, term, at === terms.length - 1)));
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 30)
    .map((message) => {
      const text = message.body
        .replace(/@\[user:([^\]\s]+)\]/g, (_, id: string) => `@${nameOf(id) ?? "someone"}`)
        .replace(/\s+/g, " ")
        .trim();
      const marks = [...text.matchAll(/[\p{L}\p{N}_]+/gu)].flatMap((found): [number, number][] =>
        terms.some((term, at) => matches(found[0].toLowerCase(), term, at === terms.length - 1)) ? [[found.index, found.index + found[0].length]] : [],
      );
      return {
        id: message.id,
        channelId: message.channelId,
        seq: message.seq,
        person: actorPerson(message.actor),
        snippet: { text, marks },
        files: message.files.map(({ name, kind }) => ({ name, kind })),
        createdAt: message.createdAt,
      };
    });
  return { hits, more: false };
}
