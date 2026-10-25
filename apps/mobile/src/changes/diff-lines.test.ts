import { describe, expect, it } from "vitest";
import { monoMetrics } from "../thread/mono-lines";
import { diffChunks, diffRows } from "./diff-lines";

const patch = ["@@ -1,3 +1,4 @@ export function hello", " keep", "-old", "+new", "+added", " tail", "@@ -20,2 +21,1 @@", "-gone", " last", "\\ No newline at end of file", ""].join("\n");

describe("diffRows", () => {
  it("numbers added and kept lines on the new side and removed ones on the old", () => {
    expect(diffRows(patch)).toEqual([
      { kind: "hunk", text: "@@ -1,3 +1,4 @@ export function hello", number: null },
      { kind: "context", text: " keep", number: 1 },
      { kind: "del", text: "-old", number: 2 },
      { kind: "add", text: "+new", number: 2 },
      { kind: "add", text: "+added", number: 3 },
      { kind: "context", text: " tail", number: 4 },
      { kind: "hunk", text: "@@ -20,2 +21,1 @@", number: null },
      { kind: "del", text: "-gone", number: 20 },
      { kind: "context", text: " last", number: 21 },
      { kind: "note", text: "\\ No newline at end of file", number: null },
    ]);
  });

  it("drops anything before the first hunk, and reads an empty patch as no rows", () => {
    expect(diffRows("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+one\n")).toEqual([
      { kind: "hunk", text: "@@ -0,0 +1 @@", number: null },
      { kind: "add", text: "+one", number: 1 },
    ]);
    expect(diffRows("")).toEqual([]);
  });
});

describe("diffChunks", () => {
  const metrics = { ...monoMetrics(1), chunkLines: 4 };

  it("splits rows into chunks with a gutter, the code and one tint per run", () => {
    const chunks = diffChunks(diffRows(patch), metrics);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({
      gutter: "\n1\n2\n2",
      code: "@@ -1,3 +1,4 @@ export function hello\n keep\n-old\n+new",
      kinds: ["hunk", "context", "del", "add"],
      runs: [
        { kind: "hunk", start: 0, length: 1 },
        { kind: "del", start: 2, length: 1 },
        { kind: "add", start: 3, length: 1 },
      ],
    });
    // A run that crosses chunks is tinted in each.
    expect(chunks[1]!.runs).toEqual([
      { kind: "add", start: 0, length: 1 },
      { kind: "hunk", start: 2, length: 1 },
      { kind: "del", start: 3, length: 1 },
    ]);
    expect(chunks[2]).toMatchObject({ gutter: "21\n", code: " last\n\\ No newline at end of file", runs: [] });
  });

  it("cuts a long line at the drawn width and expands tabs", () => {
    const [chunk] = diffChunks(diffRows(`@@ -1 +1 @@\n+\tx${"y".repeat(500)}`), { ...metrics, lineChars: 20 });
    expect(chunk!.code.split("\n")[1]).toBe(`+       x${"y".repeat(10)}…`);
  });
});
