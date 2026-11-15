import { expect, it } from "vitest";
import { listWords } from "./list-words.js";

it("says a list as Intl.ListFormat does in English, for every length", () => {
  const format = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
  for (const items of [[], ["Claude"], ["Claude", "Codex"], ["Claude", "Codex", "OpenCode"], ["a", "b", "c", "d"]]) expect(listWords(items)).toBe(format.format(items));
});
