import { expect, it } from "vitest";
import { messagePreview } from "./message-preview";

it("keeps a message's words on one line and drops its Markdown marks", () => {
  expect(messagePreview("**No, we aren't** packaging `codex` & <b>its</b> CLI.\n\nSee [the docs](https://example.com).")).toBe("No, we aren't packaging codex & its CLI. See the docs.");
});

it("reads headings, lists, tables, quotes and code in order", () => {
  const markdown = ["## Done", "- Fixed the *row*", "- Added tests", "| Platform | Downloads |", "|---|---|", "| macOS | 12 |", "> Shipped", "```ts", "run();", "```"].join("\n");
  expect(messagePreview(markdown)).toBe("Done Fixed the row Added tests Platform Downloads macOS 12 Shipped run();");
});

it("keeps escaped marks and an image's alt text", () => {
  expect(messagePreview("![Before and after](shot.png) 2 \\* 3")).toBe("Before and after 2 * 3");
});
