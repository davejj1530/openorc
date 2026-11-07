import { describe, expect, it } from "vitest";
import { filterMentions } from "./composer-mentions";

const entries = [
  { key: "everyone", name: "everyone", hint: "Whole team" },
  { key: "lead", name: "Assistant General", hint: "Lead" },
  { key: "mark", name: "Mark", hint: "Codex" },
  { key: "melo", name: "Melo", hint: "Claude Code" },
];

describe("composer mentions", () => {
  it("filters by name or key prefix, case-insensitive, and lists everyone for an empty query", () => {
    expect(filterMentions(entries, "").map((entry) => entry.key)).toEqual(["everyone", "lead", "mark", "melo"]);
    expect(filterMentions(entries, "me").map((entry) => entry.key)).toEqual(["melo"]);
    expect(filterMentions(entries, "LE").map((entry) => entry.key)).toEqual(["lead"]);
    expect(filterMentions(entries, "assistant").map((entry) => entry.key)).toEqual(["lead"]);
    expect(filterMentions(entries, "zz")).toEqual([]);
  });
});
