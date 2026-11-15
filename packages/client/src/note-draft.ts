/**
 * A draft that tags a person is a note to them: posted to the thread for the people it tags, never sent to the agent.
 * The draft carries each tag as the person's identity (`@[user:ID]`), so a name typed by hand is only words; the note
 * carries the people's names in its words, and where each name stands, so the server and every window read the tags
 * the person chose.
 */

/** A tag of a person as a draft carries it: their identity, never their name. */
export const PERSON_TAG = /@\[user:([^\]\s]+)\]/g;
export const personTag = (id: string): string => `@[user:${id}]`;

/** A note given in words, as the server words one to a person with its tag's span, held as a draft: the tag in place. */
export function draftOfNote({ to, text, mention }: { to: { id: string }; text: string; mention: { start: number; end: number } }): string {
  return `${text.slice(0, mention.start)}${personTag(to.id)}${text.slice(mention.end)}`;
}

/** Whether a draft tags someone, so it posts as a note. */
export function tagsPerson(draft: string): boolean {
  return new RegExp(PERSON_TAG.source).test(draft);
}

/**
 * The note a draft posts: its words with each tag written out as `@` and the person's name, and the place of each name,
 * in UTF-16 units as the server counts them. Null when nothing is tagged or a tag names nobody among `people`.
 */
export function noteFromDraft(draft: string, people: readonly { id: string; name: string }[]): { text: string; mentions: { userId: string; start: number; end: number }[] } | null {
  const names = new Map(people.map((person) => [person.id, person.name]));
  const source = draft.trim();
  const mentions: { userId: string; start: number; end: number }[] = [];
  let text = "";
  let at = 0;
  for (const match of source.matchAll(PERSON_TAG)) {
    const name = names.get(match[1]!);
    if (name === undefined) return null;
    text += source.slice(at, match.index);
    const start = text.length;
    text += `@${name}`;
    mentions.push({ userId: match[1]!, start, end: text.length });
    at = match.index + match[0].length;
  }
  text += source.slice(at);
  return mentions.length ? { text, mentions } : null;
}
