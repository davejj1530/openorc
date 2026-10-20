/** What the site search finds, in the order its results list them, each with its group's label. */
export const searchKinds = [
  { kind: "page", label: "Docs" },
  { kind: "section", label: "Sections" },
  { kind: "question", label: "Questions" },
  { kind: "release", label: "Changelog" },
] as const;

export type SearchKind = (typeof searchKinds)[number]["kind"];

/** One place the search can open: a docs page, a section of one, a question on the homepage, or a release. */
export interface SearchEntry {
  kind: SearchKind;
  /** Unique across the index, for the result's element id. */
  id: string;
  href: string;
  name: string;
  /** The faint line under the name. Queries match it too. */
  about: string;
}

export interface SearchGroup {
  label: string;
  entries: SearchEntry[];
}

/** How many results a group shows. */
const perGroup = 5;

/** How well an entry answers a query: 0 when its name starts with it, 1 when its name holds every word, 2 when the rest does, null when a word is missing. */
function rank(entry: SearchEntry, phrase: string, words: readonly string[]): number | null {
  const name = entry.name.toLowerCase();
  const text = `${name} ${entry.about.toLowerCase()}`;
  if (!words.every((word) => text.includes(word))) return null;
  if (name.startsWith(phrase)) return 0;
  return words.every((word) => name.includes(word)) ? 1 : 2;
}

/** What a query matches, grouped by kind in searchKinds order, the best names first in each group. */
export function search(entries: readonly SearchEntry[], query: string): SearchGroup[] {
  const phrase = query.trim().toLowerCase();
  const words = phrase.split(/\s+/).filter(Boolean);
  const scored = entries.flatMap((entry) => {
    const score = rank(entry, phrase, words);
    return score === null ? [] : [{ entry, score }];
  });
  return searchKinds
    .map(({ kind, label }) => ({
      label,
      entries: scored
        .filter(({ entry }) => entry.kind === kind)
        .sort((a, b) => a.score - b.score)
        .slice(0, perGroup)
        .map(({ entry }) => entry),
    }))
    .filter((group) => group.entries.length > 0);
}
