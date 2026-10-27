import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANGES_LISTED, FILE_DIFF_BYTES, FILE_DIFF_LINES } from "@openorc/protocol";
import { changeStats, filePatch } from "./changes.js";
import { git } from "./exec.js";
import { commitAll } from "./publish.js";

let folder: string;
let root: string;
let baseSha: string;

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-changes-"));
  root = path.join(folder, "repo");
  await mkdir(path.join(root, "src"), { recursive: true });
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  // A commit of thousands of files starts background maintenance, which writes into .git while the folder is removed.
  await git(root, ["config", "maintenance.auto", "false"]);
  await writeFile(path.join(root, "README.md"), "one\ntwo\nthree\n");
  await writeFile(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 0, 3]));
  baseSha = await commitAll(root, "init");
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const lines = (count: number, text: (i: number) => string) => Array.from({ length: count }, (_, i) => text(i + 1)).join("\n") + "\n";

describe("changeStats", () => {
  it("counts text, binary and large files, and never reads what a symlink points at", async () => {
    const secret = path.join(folder, "secret.txt");
    await writeFile(secret, "TOP SECRET VALUE\n");
    await writeFile(path.join(root, "README.md"), "one\n2\nthree\nfour\n");
    await writeFile(path.join(root, "bin.dat"), Buffer.from([0, 9, 9, 0]));
    await writeFile(path.join(root, "big.log"), "x".repeat(1024 * 1024 + 1));
    await writeFile(path.join(root, "dot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]));
    await symlink(secret, path.join(root, "link"));
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    await mkdir(path.join(root, "nested"));
    await git(path.join(root, "nested"), ["init", "-q"]);

    const changes = await changeStats(root, null);
    expect(changes.files).toEqual([
      { path: "README.md", status: "modified", oldPath: null, body: { kind: "text", insertions: 2, deletions: 1 } },
      { path: "bin.dat", status: "modified", oldPath: null, body: { kind: "binary" } },
      { path: "big.log", status: "untracked", oldPath: null, body: { kind: "omitted", reason: "large", bytes: 1024 * 1024 + 1 } },
      { path: "dot.png", status: "untracked", oldPath: null, body: { kind: "binary" } },
      { path: "link", status: "untracked", oldPath: null, body: { kind: "text", insertions: 1, deletions: 0 } },
      { path: "nested/", status: "untracked", oldPath: null, body: { kind: "omitted", reason: "special", bytes: null } },
    ]);
    expect(changes.totals).toEqual({ files: 6, insertions: 3, deletions: 1 });
    expect(changes.unlisted).toBe(0);

    const link = await filePatch(root, null, "link");
    expect(link).toMatchObject({ path: "link", status: "untracked", body: { kind: "text", insertions: 1, deletions: 0 }, cut: null });
    expect(link!.patch).toContain(`+${secret}`);
    expect(link!.patch).not.toContain("TOP SECRET");
    expect(await filePatch(root, null, "big.log")).toEqual({
      path: "big.log",
      oldPath: null,
      status: "untracked",
      body: { kind: "omitted", reason: "large", bytes: 1024 * 1024 + 1 },
      patch: "",
      cut: null,
    });
    expect(await filePatch(root, null, "bin.dat")).toMatchObject({ body: { kind: "binary" }, patch: "" });
    // Git never lists a fifo, and nothing here may open one: a read would block.
    expect(await filePatch(root, null, "pipe")).toBeNull();
  });

  it("drops git's header lines and keeps the hunks", async () => {
    await writeFile(path.join(root, "README.md"), "one\nTWO\nthree\n");
    const diff = await filePatch(root, null, "README.md");
    expect(diff).toEqual({
      path: "README.md",
      oldPath: null,
      status: "modified",
      body: { kind: "text", insertions: 1, deletions: 1 },
      patch: "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n",
      cut: null,
    });
  });

  it("names a staged rename and a deletion", async () => {
    await writeFile(
      path.join(root, "src/old-name.ts"),
      lines(20, (i) => `export const line${i} = ${i};`),
    );
    await writeFile(path.join(root, "gone.md"), "first\nsecond\n");
    await commitAll(root, "more");
    await git(root, ["mv", "src/old-name.ts", "src/new-name.ts"]);
    await appendFile(path.join(root, "src/new-name.ts"), "export const added = true;\n");
    await git(root, ["add", "src/new-name.ts"]);
    await rm(path.join(root, "gone.md"));

    const changes = await changeStats(root, null);
    expect(changes.files).toEqual([
      { path: "gone.md", status: "deleted", oldPath: null, body: { kind: "text", insertions: 0, deletions: 2 } },
      { path: "src/new-name.ts", status: "renamed", oldPath: "src/old-name.ts", body: { kind: "text", insertions: 1, deletions: 0 } },
    ]);
    const renamed = await filePatch(root, null, "src/new-name.ts");
    expect(renamed).toMatchObject({ status: "renamed", oldPath: "src/old-name.ts", body: { kind: "text", insertions: 1, deletions: 0 } });
    expect(renamed!.patch).toMatch(/^@@ /);
    expect(renamed!.patch).toContain("+export const added = true;");
    expect(renamed!.patch).not.toContain("rename from");
    const deleted = await filePatch(root, null, "gone.md");
    expect(deleted).toMatchObject({ status: "deleted", patch: "@@ -1,2 +0,0 @@\n-first\n-second\n" });
  });

  it("keeps names with spaces, unicode, a leading dash and pathspec magic literal", async () => {
    const names = ["with space.txt", "ünïcødé.txt", "-leading-dash.txt", ":(glob)*.txt"];
    await writeFile(path.join(root, "tracked-:(glob)*.md"), "before\n");
    await commitAll(root, "magic");
    await writeFile(path.join(root, "tracked-:(glob)*.md"), "after\n");
    for (const name of names) await writeFile(path.join(root, name), `${name}\n`);
    await writeFile(path.join(root, "plain.txt"), "plain\n");

    const changes = await changeStats(root, null);
    expect(changes.files.map((file) => file.path).sort()).toEqual([...names, "plain.txt", "tracked-:(glob)*.md"].sort());
    for (const name of names) {
      const diff = await filePatch(root, null, name);
      expect(diff, name).toMatchObject({ path: name, status: "untracked", patch: `@@ -0,0 +1 @@\n+${name}\n` });
    }
    expect(await filePatch(root, null, "tracked-:(glob)*.md")).toMatchObject({ status: "modified", patch: "@@ -1 +1 @@\n-before\n+after\n" });
  });

  it("measures a worktree's branch from its base, committed work included", async () => {
    await writeFile(path.join(root, "src/branch.ts"), "export const branch = 1;\n");
    await commitAll(root, "branch work");
    expect((await changeStats(root, null)).files).toEqual([]);
    expect((await changeStats(root, baseSha)).files).toEqual([{ path: "src/branch.ts", status: "added", oldPath: null, body: { kind: "text", insertions: 1, deletions: 0 } }]);
    expect(await filePatch(root, null, "src/branch.ts")).toBeNull();
    expect(await filePatch(root, baseSha, "src/branch.ts")).toMatchObject({ status: "added", patch: "@@ -0,0 +1 @@\n+export const branch = 1;\n" });
  });

  it("finds no changes for an unchanged or missing path", async () => {
    await writeFile(path.join(root, "changed.txt"), "x\n");
    expect(await filePatch(root, null, "README.md")).toBeNull();
    expect(await filePatch(root, null, "missing.txt")).toBeNull();
    expect(await filePatch(root, null, "changed")).toBeNull();
  });

  it(`lists ${CHANGES_LISTED} files of 5,000 and counts them all`, async () => {
    const bulk = path.join(root, "bulk");
    await mkdir(bulk);
    const files = Array.from({ length: 5_000 }, (_, i) => `file-${String(i).padStart(4, "0")}.ts`);
    await Promise.all(files.map((file, i) => writeFile(path.join(bulk, file), `export const v = ${i};\n`)));
    let started = performance.now();
    const untracked = await changeStats(root, null);
    const untrackedMs = performance.now() - started;
    expect(untracked.files).toHaveLength(CHANGES_LISTED);
    expect(untracked.unlisted).toBe(5_000 - CHANGES_LISTED);
    expect(untracked.totals).toEqual({ files: 5_000, insertions: 5_000, deletions: 0 });

    await commitAll(root, "bulk");
    await Promise.all(files.map((file, i) => writeFile(path.join(bulk, file), `export const v = ${i + 1};\n`)));
    started = performance.now();
    const tracked = await changeStats(root, null);
    const trackedMs = performance.now() - started;
    expect(tracked.files).toHaveLength(CHANGES_LISTED);
    expect(tracked.files[0]).toEqual({ path: "bulk/file-0000.ts", status: "modified", oldPath: null, body: { kind: "text", insertions: 1, deletions: 1 } });
    expect(tracked.totals).toEqual({ files: 5_000, insertions: 5_000, deletions: 5_000 });
    started = performance.now();
    await filePatch(root, null, "bulk/file-4999.ts");
    const oneMs = performance.now() - started;
    process.stderr.write(`changeStats: 5,000 untracked files ${untrackedMs.toFixed(0)} ms, 5,000 tracked changes ${trackedMs.toFixed(0)} ms; filePatch one of them ${oneMs.toFixed(0)} ms\n`);
  }, 60_000);

  it(`cuts a long diff at ${FILE_DIFF_LINES} lines, and a wide one at ${FILE_DIFF_BYTES / 1024} KB, at a line end`, async () => {
    await writeFile(
      path.join(root, "huge.txt"),
      lines(50_000, (i) => `line ${i}`),
    );
    const huge = await filePatch(root, null, "huge.txt");
    expect(huge!.body).toEqual({ kind: "text", insertions: 50_000, deletions: 0 });
    expect(huge!.cut).toEqual({ shownLines: FILE_DIFF_LINES, totalLines: 50_001 });
    expect(huge!.patch.split("\n")).toHaveLength(FILE_DIFF_LINES + 1);
    expect(huge!.patch.endsWith("+line 4999\n")).toBe(true);

    await writeFile(
      path.join(root, "wide.txt"),
      lines(900, (i) => `${i} ${"w".repeat(1_000)}`),
    );
    const wide = await filePatch(root, null, "wide.txt");
    expect(Buffer.byteLength(wide!.patch)).toBeLessThanOrEqual(FILE_DIFF_BYTES);
    expect(wide!.patch.endsWith("\n")).toBe(true);
    expect(wide!.cut).toEqual({ shownLines: wide!.patch.split("\n").length - 1, totalLines: 901 });
    expect(wide!.cut!.shownLines).toBeLessThan(901);
  });
});
