import { harnessName } from "@openorc/protocol";

/** A member the composer can address with `@`. `name` is what gets inserted; `key` only identifies it. */
export interface MentionEntry {
  key: string;
  name: string;
  hint: string;
}

type Roster = { members: { key: string; name: string; managerKey: string | null; settings: { agent: string } }[] };

/** Who a team message can address: the whole team, the lead by name, then every member with its provider. The server reads the names from the text. */
export function teamMentionEntries(revision: Roster): MentionEntry[] {
  const lead = revision.members.find((member) => member.managerKey === null);
  return [
    { key: "everyone", name: "everyone", hint: "Whole team" },
    ...(lead ? [{ key: "lead", name: lead.name, hint: "Lead" }] : []),
    ...revision.members.filter((member) => member.managerKey !== null).map((member) => ({ key: member.key, name: member.name, hint: harnessName(member.settings.agent) })),
  ];
}

/** The `@` word at the caret, when the `@` starts a word. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\s)@(\S*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[1] ?? "";
  return { start: caret - query.length - 1, query };
}

/** Prefix matches on the name or key, case-insensitive; an empty query lists everyone. */
export function filterMentions<T extends Pick<MentionEntry, "key" | "name">>(entries: T[], query: string): T[] {
  const needle = query.toLowerCase();
  return entries.filter((entry) => entry.name.toLowerCase().startsWith(needle) || entry.key.toLowerCase().startsWith(needle));
}

/** Replace the `@` word with `@Name ` and put the caret after the space. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const mention = `@${name} `;
  return { text: `${text.slice(0, start)}${mention}${text.slice(caret)}`, caret: start + mention.length };
}
