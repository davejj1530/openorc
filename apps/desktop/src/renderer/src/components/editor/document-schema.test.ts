import { describe, expect, it } from "vitest";
import { canEditRichly, markdownManager, safeImageSource, slashQuery } from "./document-schema";

describe("task document compatibility", () => {
  it.each([
    "",
    "## Goal\n\nKeep **bold**, *italic*, ~~removed~~, and `code`.\n\n[Link](https://example.com)",
    "```ts\nconst x = '<tag>';\n```",
    "Before\n\n![Screenshot](openorc-asset://attachments/abc-123.png)\n\nAfter",
  ])("allows lossless rich editing: %s", (source) => {
    expect(canEditRichly(source)).toBe(true);
    const manager = markdownManager();
    const once = manager.serialize(manager.parse(source));
    expect(manager.serialize(manager.parse(once))).toBe(once);
  });
  it.each(["<!-- Keep this comment -->\nText", "Math $x^2$", "![Unsafe](javascript:alert)", "#### Unsupported heading"])("keeps unsupported content in source: %s", (source) =>
    expect(canEditRichly(source)).toBe(false),
  );
  it("only allows safe image sources", () => {
    expect(safeImageSource("openorc-asset://attachments/abc-123.png")).toBe(true);
    expect(safeImageSource("openorc-asset://attachments/../secret.png")).toBe(false);
    expect(safeImageSource("file:///etc/passwd")).toBe(false);
    expect(safeImageSource("javascript:alert(1)")).toBe(false);
  });
});

it("slash commands only match at the start of a paragraph, without paths", () => {
  expect(slashQuery("/image", 20, 26)).toEqual({ from: 20, to: 26, query: "image" });
  expect(slashQuery("/", 1, 2)?.query).toBe("");
  for (const value of ["https://example.com", "Use /image", "/usr/local", "~/file"]) expect(slashQuery(value, 1, value.length + 1)).toBeNull();
});
