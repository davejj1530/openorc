/**
 * How alike two tasks read, by title and spec, so a task that is already open isn't created twice. A few stemmed
 * content words each, compared by overlap.
 */

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const stopWords = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "it",
  "is",
  "be",
  "that",
  "this",
  "as",
  "by",
  "at",
  "from",
  "so",
  "we",
  "you",
  "should",
  "add",
  "make",
  "use",
]);

/** Enough stemming to make "escaping" and "escape" the same word without a dictionary. */
function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/, "");
}

export function wordSet(text: string): Set<string> {
  return new Set(
    normalizeTitle(text)
      .split(" ")
      .filter((w) => w.length > 2 && !stopWords.has(w))
      .map(stem),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both += 1;
  return both / (a.size + b.size - both);
}
