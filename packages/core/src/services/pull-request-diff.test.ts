import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitAll, git } from "@openorc/git";
import { REVIEW_DIFF, changedSince } from "./pull-request-diff.js";

const file = (path: string, ...hunks: string[]) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n");

describe("a later round's view of the diff", () => {
  // The pull request as a whole: two separate changes to app.ts, one to util.ts.
  const full = [
    file(
      "app.ts",
      "@@ -2,3 +2,3 @@ start",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " const c = 4;",
      "@@ -40,3 +40,4 @@ stop",
      " const x = 1;",
      "-const y = 2;",
      "+const y = 20;",
      "+const z = 30;",
      " const w = 4;",
    ),
    file("util.ts", "@@ -1,2 +1,2 @@", "-export const u = 1;", "+export const u = 2;", " export const v = 1;"),
  ].join("\n");

  it("keeps only the hunks that changed after the earlier commit, in the whole diff's numbering", () => {
    // Since the last round only z changed, and the diff from there numbers its old side differently.
    const since = file("app.ts", "@@ -41,2 +41,2 @@ stop", " const y = 20;", "-const z = 3;", "+const z = 30;");
    const view = changedSince(full, since);
    expect(view).toContain("@@ -40,3 +40,4 @@ stop");
    expect(view).toContain("-const y = 2;");
    expect(view).not.toContain("@@ -2,3 +2,3 @@");
    expect(view).not.toContain("util.ts");
    expect(view.endsWith("\n")).toBe(true);
  });

  it("keeps a hunk where lines were removed after the earlier commit", () => {
    const since = file("util.ts", "@@ -1,3 +1,2 @@", " export const u = 2;", "-export const gone = 1;", " export const v = 1;");
    expect(changedSince(full, since)).toContain("+export const u = 2;");
  });

  it("is empty when nothing that differs from the base changed", () => {
    expect(changedSince(full, file("README.md", "@@ -1 +1 @@", "-a", "+b"))).toBe("");
  });
});

it("shapes the agent's diff as GitHub does, whatever the user's diff settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openorc-review-diff-"));
  try {
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.email", "fixture@example.com"]);
    await git(root, ["config", "user.name", "Fixture"]);
    const lines = Array.from({ length: 30 }, (_, index) => (index % 4 === 0 ? "" : `line ${index + 1}`));
    await writeFile(path.join(root, "app.ts"), `${lines.join("\n")}\n`);
    const base = await commitAll(root, "base");
    lines[6] = "changed 7";
    lines[20] = "changed 21";
    await writeFile(path.join(root, "app.ts"), `${lines.join("\n")}\n`);
    const head = await commitAll(root, "head");
    // Settings that would widen hunks, merge them, and drop the marker of blank context lines.
    for (const [key, value] of [
      ["diff.context", "8"],
      ["diff.interHunkContext", "20"],
      ["diff.suppressBlankEmpty", "true"],
      ["diff.algorithm", "patience"],
    ])
      await git(root, ["config", key!, value!]);
    const diff = (await git(root, [...REVIEW_DIFF, base, head])).stdout;
    expect(diff.match(/^@@ .* @@/gm)).toEqual(["@@ -4,7 +4,7 @@", "@@ -18,7 +18,7 @@"]);
    expect(diff.split("\n")).toContain(" ");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
