import type { SearchEntry, SearchKind } from "../lib/search";
import { releaseAnchor, type ChangelogRelease } from "./changelog";
import { docHref, docPage, docPages, type DocPage } from "./docs";
import { questions, type Question } from "./faq";

const entry = (kind: SearchKind, href: string, name: string, about: string): SearchEntry => ({ kind, id: `${kind}-${href}`, href, name, about });

const pageEntry = (page: DocPage) => entry("page", docHref(page.slug), page.title, page.description);

const sectionEntries = (page: DocPage) => page.sections.map((section) => entry("section", `${docHref(page.slug)}#${section.id}`, section.title, page.title));

const questionEntry = (question: Question) => entry("question", `/#${question.id}`, question.question, question.answer);

const releaseEntry = (release: ChangelogRelease) =>
  entry(
    "release",
    `/changelog/#${releaseAnchor(release.tag)}`,
    release.tag,
    release.highlights
      .slice(0, 2)
      .map((highlight) => highlight.replace(/\.$/, ""))
      .join(". "),
  );

/** Everything the search finds, built once per site build and served at /search.json. */
export function searchEntries(releases: readonly ChangelogRelease[]): SearchEntry[] {
  return [...docPages.map(pageEntry), ...docPages.flatMap(sectionEntries), ...questions.map(questionEntry), ...releases.map(releaseEntry)];
}

/** What the search offers before anything is typed: the pages most visitors start from. */
export const searchSuggestions: SearchEntry[] = ["quickstart", "messaging", "tasks", "slack", "known-issues"].map((slug) => {
  const page = docPage(slug);
  if (!page) throw new Error(`Unknown docs page in search suggestions: ${slug}`);
  return pageEntry(page);
});
