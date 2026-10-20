import assert from "node:assert/strict";
import { test } from "node:test";
import { search } from "../lib/search";
import type { ChangelogRelease } from "./changelog";
import { docHref, docPages } from "./docs";
import { searchEntries, searchSuggestions } from "./search-index";

const release: ChangelogRelease = {
  tag: "v0.1.0-beta.13",
  url: "https://github.com/davejj1530/openorc/releases/tag/v0.1.0-beta.13",
  publishedAt: "2026-10-19T10:00:00Z",
  prerelease: true,
  highlights: ["One ground, fill steps and a single weight", "Quieter sidebar.", "Calmer turns"],
  assets: [],
};
const entries = searchEntries([release]);

void test("gives every entry its own id, so each result can be the active descendant", () => {
  assert.equal(new Set(entries.map(({ id }) => id)).size, entries.length);
});

void test("indexes every docs page and links every section to its heading on that page", () => {
  for (const page of docPages) {
    assert.ok(
      entries.some(({ kind, href }) => kind === "page" && href === docHref(page.slug)),
      `missing page ${page.slug}`,
    );
    for (const section of page.sections) {
      const found = entries.find(({ kind, href }) => kind === "section" && href === `${docHref(page.slug)}#${section.id}`);
      assert.equal(found?.about, page.title, `section ${page.slug}#${section.id}`);
    }
  }
});

void test("links a question to its place on the homepage and a release to its place on the changelog", () => {
  assert.deepEqual(search(entries, "where does my work live")[0]?.entries[0]?.href, "/#where-work-lives");
  const found = entries.find(({ kind }) => kind === "release");
  assert.deepEqual(found && { href: found.href, name: found.name, about: found.about }, {
    href: "/changelog/#release-v0-1-0-beta-13",
    name: "v0.1.0-beta.13",
    about: "One ground, fill steps and a single weight. Quieter sidebar",
  });
});

void test("suggests pages the index holds", () => {
  for (const suggestion of searchSuggestions) assert.ok(entries.some(({ id }) => id === suggestion.id));
});
