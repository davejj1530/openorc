import { expect, it } from "vitest";
import { plainPreview } from "./message-preview";

it("reads a reply's Markdown as one line of plain text", () => {
  expect(plainPreview("They're gone from Codex too.\n\n- **Deleted:** `tdd`, `codebase-design` and more")).toBe("They're gone from Codex too. Deleted: tdd, codebase-design and more");
  expect(plainPreview("Defaults.\n\n| Scenario | Coordinated |\n|---|---|\n| Config | on |")).toBe("Defaults. Scenario Coordinated Config on");
  expect(plainPreview("## Goal\nSee [the docs](https://example.com), *this* or _that_ and ~~old~~")).toBe("Goal See the docs, this or that and old");
  expect(plainPreview("1. First\n2. Second\n- [ ] A task\n> Quoted")).toBe("First Second A task Quoted");
  expect(plainPreview("```ts\nconst a = 1;\n```\nDone.")).toBe("const a = 1; Done.");
});

it("leaves words that only look like Markdown as they are", () => {
  expect(plainPreview("Use snake_case_names and 2 * 3 = 6")).toBe("Use snake_case_names and 2 * 3 = 6");
});
