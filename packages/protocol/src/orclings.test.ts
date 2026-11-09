import { expect, it } from "vitest";
import { chatBubbles, orclingWakeKey, OrclingWakes } from "./orclings.js";

it("splits a text into one message per paragraph, keeping code blocks and spaced lists whole", () => {
  expect(chatBubbles("on it\n\nchecking openorc now")).toEqual(["on it", "checking openorc now"]);
  expect(chatBubbles("here:\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nthat's it")).toEqual(["here:", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "that's it"]);
  expect(chatBubbles("plan:\n\n- one\n\n- two\n\n\nok?")).toEqual(["plan:", "- one\n\n- two", "ok?"]);
  expect(chatBubbles("  \n\n")).toEqual([]);
});

it("treats the same time on the same days as one wake, and allows waking on opening once", () => {
  expect(orclingWakeKey({ kind: "time", at: "09:00", days: [5, 1, 1] })).toBe(orclingWakeKey({ kind: "time", at: "09:00", days: [1, 5] }));
  expect(OrclingWakes.safeParse([{ kind: "startup" }, { kind: "startup" }]).success).toBe(false);
  expect(OrclingWakes.safeParse([{ kind: "time", at: "24:00", days: [1] }]).success).toBe(false);
});
