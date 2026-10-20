import assert from "node:assert/strict";
import { test } from "node:test";
import { search, type SearchEntry, type SearchKind } from "./search";

const entry = (kind: SearchKind, name: string, about = ""): SearchEntry => ({ kind, id: `${kind}-${name}`, href: `/${kind}/${name}`, name, about });
const names = (query: string, entries: SearchEntry[]) => search(entries, query).map(({ label, entries: found }) => [label, found.map(({ name }) => name)]);

void test("ranks names that start with the query, then names holding every word, then context", () => {
  const entries = [entry("section", "Approve from Slack", "Slack"), entry("section", "Bots", "Mention the slack bot"), entry("section", "Slack setup", "Integrations")];
  assert.deepEqual(names("slack", entries), [["Sections", ["Slack setup", "Approve from Slack", "Bots"]]]);
});

void test("matches every word anywhere, ignoring case, and leaves out entries missing one", () => {
  const entries = [entry("release", "v0.1.0-beta.13", "One ground. Quieter sidebar"), entry("release", "v0.1.0-beta.12", "Browser tabs")];
  assert.deepEqual(names("BETA.13", entries), [["Changelog", ["v0.1.0-beta.13"]]]);
  assert.deepEqual(names("beta quieter", entries), [["Changelog", ["v0.1.0-beta.13"]]]);
  assert.deepEqual(names("beta missing", entries), []);
});

void test("groups results by kind in a fixed order and caps each group", () => {
  const entries = [entry("release", "Tasks release"), entry("question", "Do tasks start work?"), ...Array.from({ length: 8 }, (_, i) => entry("section", `Tasks ${i}`)), entry("page", "Tasks")];
  const groups = search(entries, "tasks");
  assert.deepEqual(
    groups.map(({ label }) => label),
    ["Docs", "Sections", "Questions", "Changelog"],
  );
  assert.equal(groups[1]?.entries.length, 5);
});
