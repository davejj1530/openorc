import { describe, expect, it } from "vitest";
import { replySegments } from "./reply-images";

describe("replySegments", () => {
  it("lifts out an image of a file on its own line, keeping the words around it", () => {
    expect(replySegments("Fixed now:\n\n![Agent details, dark](/Users/me/shots/dark.png)\n\n- The brief reads as text.")).toEqual([
      { kind: "text", text: "Fixed now:" },
      { kind: "image", path: "/Users/me/shots/dark.png", alt: "Agent details, dark" },
      { kind: "text", text: "- The brief reads as text." },
    ]);
  });

  it("reads angle-bracket paths with spaces and titles, and relative paths", () => {
    expect(replySegments('![](<shots/a b.png> "Shot")')).toEqual([{ kind: "image", path: "shots/a b.png", alt: "" }]);
  });

  it("leaves web images, text without images and fenced code to the Markdown", () => {
    const text = "See ![logo](https://example.com/a.png).\n\n```md\n![x](/tmp/x.png)\n```";
    expect(replySegments(text)).toEqual([{ kind: "text", text }]);
  });

  it("splits an image in the middle of a line", () => {
    expect(replySegments("Before ![a](/tmp/a.png) after")).toEqual([
      { kind: "text", text: "Before " },
      { kind: "image", path: "/tmp/a.png", alt: "a" },
      { kind: "text", text: " after" },
    ]);
  });
});
