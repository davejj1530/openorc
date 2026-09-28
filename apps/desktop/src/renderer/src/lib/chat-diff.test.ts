import { expect, it } from "vitest";
import { parsePatchFiles } from "@pierre/diffs";
import { toolDiff } from "./chat-diff";

it("retains provider line numbers and quoted file paths in per-file hunks", () => {
  const patch = toolDiff([
    { path: "src/my file.ts", kind: { type: "update" }, diff: "@@ -84 +84 @@\n-old\n+new\n" },
    { path: "new.ts", kind: { type: "add" }, diff: "@@ -0,0 +1 @@\n+created\n" },
    { path: "gone.ts", kind: { type: "delete" }, diff: "@@ -1 +0,0 @@\n-removed\n" },
  ]);
  const files = parsePatchFiles(patch!, undefined, true).flatMap((part) => part.files);
  expect(files.map((file) => file.name)).toEqual(["src/my file.ts", "new.ts", "gone.ts"]);
  expect(files[1]?.additionLines.join("")).toContain("created");
  expect(files[2]?.deletionLines.join("")).toContain("removed");
  expect(patch).toContain("@@ -84 +84 @@");
});

it("preserves full patches and falls back when edit data has no trustworthy line locations", () => {
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  expect(toolDiff([{ path: "a.ts", diff }])).toBe(diff);
  for (const input of [null, {}, [], [{ path: "a.ts", diff: "+new" }], [{ path: "a.ts", diff }, { path: "b.ts" }]]) expect(toolDiff(input)).toBeNull();
});
