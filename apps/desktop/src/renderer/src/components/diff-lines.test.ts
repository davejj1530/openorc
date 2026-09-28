import { describe, expect, it } from "vitest";
import { commentAnchor, isOutdated } from "@openorc/protocol";

const chunk = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,4 +10,5 @@ export function start() {",
  "   const port = 3000;",
  "-  listen(port);",
  "+  const server = listen(port);",
  "+  return server;",
  " }",
  "\\ No newline at end of file",
  "@@ -40,2 +41,2 @@",
  "-// old footer",
  "+// new footer",
  " // end",
].join("\n");

const firstHunk = "  const port = 3000;\n  listen(port);\n  const server = listen(port);\n  return server;";

describe("comment anchors", () => {
  it("anchors a click to one line", () => {
    expect(commentAnchor(chunk, { line: 12, side: "new" }, { line: 12, side: "new" })).toEqual({ startLine: null, startSide: null, line: 12, side: "new", lineText: "  return server;" });
    expect(commentAnchor(chunk, { line: 11, side: "old" }, { line: 11, side: "old" })).toEqual({ startLine: null, startSide: null, line: 11, side: "old", lineText: "  listen(port);" });
  });

  it("reads a range top to bottom whichever way it was dragged", () => {
    const down = commentAnchor(chunk, { line: 10, side: "new" }, { line: 12, side: "new" });
    expect(down).toEqual({ startLine: 10, startSide: "new", line: 12, side: "new", lineText: firstHunk });
    expect(commentAnchor(chunk, { line: 12, side: "new" }, { line: 10, side: "new" })).toEqual(down);
  });

  it("keeps both sides when a range runs from a removed line to an added one", () => {
    expect(commentAnchor(chunk, { line: 11, side: "old" }, { line: 11, side: "new" })).toEqual({
      startLine: 11,
      startSide: "old",
      line: 11,
      side: "new",
      lineText: "  listen(port);\n  const server = listen(port);",
    });
  });

  it("stops a range at the edge of the hunk it started in", () => {
    expect(commentAnchor(chunk, { line: 12, side: "new" }, { line: 41, side: "new" })).toEqual({ startLine: 12, startSide: "new", line: 13, side: "new", lineText: "  return server;\n}" });
    expect(commentAnchor(chunk, { line: 41, side: "new" }, { line: 10, side: "new" })).toEqual({
      startLine: 40,
      startSide: "old",
      line: 41,
      side: "new",
      lineText: "// old footer\n// new footer",
    });
  });

  it("has nothing to anchor when the starting line is not in the diff", () => {
    expect(commentAnchor(chunk, { line: 30, side: "new" }, { line: 12, side: "new" })).toBeNull();
    expect(commentAnchor("", { line: 1, side: "new" }, { line: 1, side: "new" })).toBeNull();
  });
});

describe("outdated comments", () => {
  it("marks a single-line comment outdated only when its line changed or left the diff", () => {
    expect(isOutdated({ startLine: null, startSide: null, line: 12, side: "new", lineText: "  return server;" }, chunk)).toBe(false);
    expect(isOutdated({ startLine: null, startSide: null, line: 12, side: "new", lineText: "  return app;" }, chunk)).toBe(true);
    expect(isOutdated({ startLine: null, startSide: null, line: 30, side: "new", lineText: "anything" }, chunk)).toBe(true);
    expect(isOutdated({ startLine: null, startSide: null, line: 12, side: "new", lineText: null }, chunk)).toBe(false);
    expect(isOutdated({ startLine: null, startSide: null, line: null, side: null, lineText: null }, chunk)).toBe(false);
  });

  it("marks a range outdated when any of its lines changed", () => {
    const range = { startLine: 10, startSide: "new" as const, line: 12, side: "new" as const };
    expect(isOutdated({ ...range, lineText: firstHunk }, chunk)).toBe(false);
    expect(isOutdated({ ...range, lineText: firstHunk.replace("3000", "8080") }, chunk)).toBe(true);
    expect(isOutdated({ ...range, startLine: 40, startSide: "old", lineText: firstHunk }, chunk)).toBe(true);
  });
});
