/** A person a draft tags, and the words after `@` that stand for them in it: their name, or the server's words for them. */
export interface DraftTag {
  id: string;
  name: string;
}

/** The note a draft posts: its words, where each tag stands in them, and the note it answers. */
export interface PhoneNote {
  text: string;
  mentions: { userId: string; start: number; end: number }[];
  replyTo?: string;
}

/** The tags whose words still stand in the draft: one deleted from the words tags no one. */
export const standingTags = (text: string, tags: readonly DraftTag[]): DraftTag[] => tags.filter((tag) => text.includes(`@${tag.name}`));

/** The note a draft answers, by Reply on it, and its author, whose tag the answer keeps. */
export interface DraftReply {
  noteId: string;
  authorId: string;
}

/**
 * The note a phone's draft posts: its words as written, and where each tag's words stand in them, in UTF-16 units as
 * the server counts them. Null when it tags no one, so it is a message to the agent. A longer name is read first, so
 * "@Mara Okafor" is never read as "@Mara". It answers the note it replies to for as long as it still tags that note's
 * author.
 */
export function phoneNote(text: string, tags: readonly DraftTag[], reply?: DraftReply): PhoneNote | null {
  const words = text.trim();
  const mentions: PhoneNote["mentions"] = [];
  const taken = (start: number, end: number) => mentions.some((mention) => start < mention.end && end > mention.start);
  for (const tag of standingTags(words, tags).sort((a, b) => b.name.length - a.name.length)) {
    const written = `@${tag.name}`;
    for (let at = words.indexOf(written); at !== -1; at = words.indexOf(written, at + written.length)) {
      if (!taken(at, at + written.length)) mentions.push({ userId: tag.id, start: at, end: at + written.length });
    }
  }
  if (!mentions.length) return null;
  mentions.sort((a, b) => a.start - b.start);
  return reply && mentions.some((mention) => mention.userId === reply.authorId) ? { text: words, mentions, replyTo: reply.noteId } : { text: words, mentions };
}

/** The `@` word the caret is in, from its `@` to the caret: where a pick puts the tag, and the words it looks for. */
export function tagWordAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1 || (at > 0 && !/\s/.test(before[at - 1]!))) return null;
  const query = before.slice(at + 1);
  return /\s/.test(query) ? null : { start: at, query };
}

/** The draft's words in runs, each tag's words a run of its own, for the prompt to draw them in the mention ink. */
export function tagRuns(text: string, tags: readonly DraftTag[]): { text: string; tag: boolean }[] {
  const words = standingTags(text, tags).map((tag) => `@${tag.name}`);
  if (!words.length) return [{ text, tag: false }];
  const pattern = new RegExp(
    `(${words
      .sort((a, b) => b.length - a.length)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")})`,
  );
  return text
    .split(pattern)
    .filter(Boolean)
    .map((run) => ({ text: run, tag: words.includes(run) }));
}
