import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { git } from "./exec.js";
import { grepWorkingTree, type GrepLimits, type GrepQuery } from "./grep.js";

const roots: string[] = [];
afterAll(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

/** A repository holding `tracked` in its index and `untracked` beside it. */
async function repo(tracked: Record<string, string | Buffer>, untracked: Record<string, string | Buffer> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openorc-grep-"));
  roots.push(root);
  await git(root, ["init", "-q", "-b", "main"]);
  const write = async (files: Record<string, string | Buffer>) => {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), content);
    }
  };
  await write(tracked);
  await git(root, ["add", "--all"]);
  await write(untracked);
  return root;
}

const literal = (pattern: string, ignoreCase = false): GrepQuery => ({ pattern, fixed: true, ignoreCase });
const limits = (total = 100, perFile = 100, signal = new AbortController().signal): GrepLimits => ({ total, perFile, signal });
const many = (count: number, text: string) => Array.from({ length: count }, () => text).join("\n") + "\n";

it("finds tracked and untracked files and leaves out ignored and binary ones", async () => {
  const root = await repo(
    { ".gitignore": "*.log\n", "src/cart.ts": "const needle = 1;\nconst other = 2;\n" },
    { "notes.md": "a needle here\n", "debug.log": "needle\n", "image.bin": Buffer.from("needle\0binary") },
  );
  expect(await grepWorkingTree(root, literal("needle"), limits())).toEqual({
    kind: "lines",
    truncated: false,
    lines: [
      { path: "notes.md", line: 1, text: "a needle here" },
      { path: "src/cart.ts", line: 1, text: "const needle = 1;" },
    ],
  });
});

it("reads each record whole when a path holds a colon, a space or a line break", async () => {
  const root = await repo({ "odd dir/a:b c.txt": "x\nneedle:12:text\n", "line\nbreak.txt": "needle\n" });
  const result = await grepWorkingTree(root, literal("needle"), limits());
  expect(result.kind === "lines" && [...result.lines].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
    { path: "line\nbreak.txt", line: 1, text: "needle" },
    { path: "odd dir/a:b c.txt", line: 2, text: "needle:12:text" },
  ]);
});

it("stops at the limit and says more matched, but not when the matches just fit", async () => {
  const root = await repo({ "a.txt": many(3, "needle"), "b.txt": many(3, "needle") });
  const stopped = await grepWorkingTree(root, literal("needle"), limits(4));
  expect(stopped).toMatchObject({ kind: "lines", truncated: true });
  expect(stopped.kind === "lines" && stopped.lines.map((line) => `${line.path}:${line.line}`)).toEqual(["a.txt:1", "a.txt:2", "a.txt:3", "b.txt:1"]);
  expect(await grepWorkingTree(root, literal("needle"), limits(6))).toMatchObject({ kind: "lines", truncated: false });
});

it("keeps only the first lines of a file that matches too often, and says some were left out", async () => {
  const root = await repo({ "lock.json": many(50, "needle"), "z.txt": "needle\n" });
  const result = await grepWorkingTree(root, literal("needle"), limits(100, 2));
  expect(result).toMatchObject({ kind: "lines", truncated: true });
  expect(result.kind === "lines" && result.lines.map((line) => `${line.path}:${line.line}`)).toEqual(["lock.json:1", "lock.json:2", "z.txt:1"]);
});

it("reads the same records whatever the user's git config says about colors, columns and full names", async () => {
  const root = await repo({ "app/a.txt": "needle\n" });
  for (const [key, value] of [
    ["color.ui", "always"],
    ["grep.column", "true"],
    ["grep.fullName", "true"],
  ] as const) {
    await git(root, ["config", key, value]);
  }
  expect(await grepWorkingTree(path.join(root, "app"), literal("needle"), limits())).toEqual({ kind: "lines", truncated: false, lines: [{ path: "a.txt", line: 1, text: "needle" }] });
});

it("answers a pattern git can't read as invalid, while the same text as a literal is searched", async () => {
  const root = await repo({ "a.txt": "call(\n" });
  const invalid = await grepWorkingTree(root, { pattern: "call(", fixed: false, ignoreCase: false }, limits());
  expect(invalid.kind).toBe("invalid");
  expect(invalid.kind === "invalid" && invalid.message).toMatch(/\w/);
  expect(await grepWorkingTree(root, literal("call("), limits())).toEqual({ kind: "lines", truncated: false, lines: [{ path: "a.txt", line: 1, text: "call(" }] });
});

it("searches for a pattern that starts with a dash instead of taking it as an option", async () => {
  const root = await repo({ "a.txt": "run --version\n" });
  expect(await grepWorkingTree(root, literal("--version"), limits())).toMatchObject({ lines: [{ path: "a.txt", line: 1 }] });
});

it("matches either case only when asked", async () => {
  const root = await repo({ "a.txt": "Needle\n" });
  expect(await grepWorkingTree(root, literal("needle"), limits())).toMatchObject({ lines: [] });
  expect(await grepWorkingTree(root, literal("needle", true), limits())).toMatchObject({ lines: [{ text: "Needle" }] });
});

it("keeps the start of a very long line and skips the rest", async () => {
  const root = await repo({ "bundle.js": `needle${"x".repeat(100_000)}\nneedle again\n` });
  const result = await grepWorkingTree(root, literal("needle"), limits());
  expect(result.kind === "lines" && result.lines.map((line) => [line.line, line.text.length])).toEqual([
    [1, 8 * 1024],
    [2, "needle again".length],
  ]);
});

it("answers at once, marked truncated, when the search was already stopped", async () => {
  const root = await repo({ "a.txt": "needle\n" });
  const stopped = new AbortController();
  stopped.abort();
  expect(await grepWorkingTree(root, literal("needle"), limits(100, 100, stopped.signal))).toMatchObject({ kind: "lines", truncated: true });
});

it("ends git once more lines arrive than the limit lets through, instead of waiting for it to finish", async () => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "openorc-grep-bin-"));
  roots.push(bin);
  await writeFile(path.join(bin, "git"), "#!/bin/sh\nprintf 'a.txt\\0001\\000needle\\na.txt\\0002\\000needle\\n'\nexec sleep 30\n");
  await chmod(path.join(bin, "git"), 0o755);
  const previous = process.env["PATH"];
  process.env["PATH"] = `${bin}:${previous ?? ""}`;
  try {
    expect(await grepWorkingTree(bin, literal("needle"), limits(1))).toEqual({ kind: "lines", truncated: true, lines: [{ path: "a.txt", line: 1, text: "needle" }] });
  } finally {
    process.env["PATH"] = previous;
  }
}, 10_000);
