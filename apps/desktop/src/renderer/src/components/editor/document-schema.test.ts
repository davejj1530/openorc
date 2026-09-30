import { getSchema } from "@tiptap/react";
import { describe, expect, it } from "vitest";
import { documentExtensions, markdownManager, slashQuery } from "./document-schema";

const schema = getSchema(documentExtensions());
const roundTrip = (source: string) => markdownManager().serialize(markdownManager().parse(source));

describe("task documents in rich text", () => {
  it.each([
    "## Goal\n\nKeep **bold**, *italic*, ~~removed~~, and `code`.\n\n[Link](https://example.com)",
    "```ts\nconst x = '<tag>';\n```",
    "<!-- Keep this comment -->\n\nText",
    "<details><summary>More</summary>\n\nHidden body\n\n</details>",
    "Press <kbd>Cmd</kbd> and wait for <model>.",
    "#### Deep heading",
    "$$\nx_1 + y^2\n$$",
    "Inline $$x_1^2$$ math",
    "A footnote[^1].\n\n[^1]: Its text.",
    "[![CI](https://example.com/badge.svg)](https://example.com/actions)",
    "Before\n\n![Screenshot](openorc-asset://attachments/abc-123.png)\n\nAfter",
    "1. First\n2. Look\n![Screenshot](openorc-asset://attachments/abc-123.png)\n3. Third",
  ])("keeps what it has no rich form for as written: %s", (source) => {
    expect(roundTrip(source)).toBe(source);
    expect(() => schema.nodeFromJSON(markdownManager().parse(source)).check()).not.toThrow();
  });

  it("keeps a lone image inside its paragraph, as Markdown reads it", () => {
    expect(markdownManager().parse("![Screenshot](openorc-asset://attachments/abc-123.png)").content?.[0]?.type).toBe("paragraph");
  });

  it("drops a list item's indent from its continuation lines", () => {
    const source = "2. Look\n   ![Screenshot](openorc-asset://attachments/abc-123.png)";
    expect(roundTrip(source)).toBe("2. Look\n![Screenshot](openorc-asset://attachments/abc-123.png)");
    expect(roundTrip(roundTrip(source))).toBe(roundTrip(source));
  });
});

it("slash commands only match at the start of a paragraph, without paths", () => {
  expect(slashQuery("/image", 20, 26)).toEqual({ from: 20, to: 26, query: "image" });
  expect(slashQuery("/", 1, 2)?.query).toBe("");
  for (const value of ["https://example.com", "Use /image", "/usr/local", "~/file"]) expect(slashQuery(value, 1, value.length + 1)).toBeNull();
});
