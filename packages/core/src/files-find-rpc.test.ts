import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { settings, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { WORKSPACE_ID, type FindQuery, type Thread } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { rpcClient } from "./rpc-test-client.js";

let root: string;
let checkout: string;
let core: OpenOrc;
let thread: Thread;
const call = rpcClient(() => core);
const conversation = { agent: "codex" as const, model: "fixture", mode: "act" as const, permissionMode: "trusted" as const };
const literal = (text: string): FindQuery => ({ text, regex: false, caseSensitive: false });
const many = (count: number, text: string) => Array.from({ length: count }, () => text).join("\n") + "\n";

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-find-rpc-")));
  checkout = path.join(root, "app");
  await mkdir(path.join(checkout, "src"), { recursive: true });
  await git(checkout, ["init", "-q", "-b", "main"]);
  await git(checkout, ["config", "user.email", "fixture@example.com"]);
  await git(checkout, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(checkout, "src", "cart.ts"), "export const needle = 1;\n");
  await commitAll(checkout, "Fixture baseline");
  core = await OpenOrc.create({ dataDir: path.join(root, "data"), ephemeral: true, transport: { push: () => {} } });
  settings.set(core.db, "extraction.provider", "off");
  const project = await core.projects.import(checkout);
  thread = threads.insert(core.db, { projectId: project.id, title: "In the checkout", ...conversation });
});
afterEach(async () => {
  await core.close();
  await rm(root, { recursive: true, force: true });
});

const find = (query: FindQuery, id = thread.id) => call("files.find", { scope: { kind: "thread", id }, query });

/** A Workspace conversation whose chosen folder has no git, holding `files`. */
async function workspaceThread(files: Record<string, string>): Promise<Thread> {
  const folder = path.join(root, "notes");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true });
    await writeFile(path.join(folder, name), text);
  }
  const notes = threads.insert(core.db, { projectId: WORKSPACE_ID, title: "Notes", ...conversation });
  return threads.update(core.db, notes.id, { workingDirectory: folder });
}

it("finds lines in the conversation's git folder, untracked files included, grouped by file", async () => {
  await writeFile(path.join(checkout, "src", "draft.ts"), "// a needle\nconst x = 1;\n");
  expect(await find(literal("NEEDLE"))).toEqual({
    kind: "matches",
    truncated: false,
    groups: [
      { path: "src/cart.ts", lines: [{ line: 1, text: "export const needle = 1;" }] },
      { path: "src/draft.ts", lines: [{ line: 1, text: "// a needle" }] },
    ],
  });
  expect(await find({ text: "NEEDLE", regex: false, caseSensitive: true })).toEqual({ kind: "matches", truncated: false, groups: [] });
});

it("walks a folder without git, skipping hidden folders and dependencies", async () => {
  const notes = await workspaceThread({ "ideas.md": "# needle\n", ".cache/old.md": "needle\n", "node_modules/pkg/index.js": "needle\n", "logo.png": "needle\0" });
  expect(await find(literal("needle"), notes.id)).toEqual({ kind: "matches", truncated: false, groups: [{ path: "ideas.md", lines: [{ line: 1, text: "# needle" }] }] });
});

it("answers a regular expression the folder's search can't read as invalid, with or without git", async () => {
  const notes = await workspaceThread({ "ideas.md": "call(\n" });
  expect(await find({ text: "call(", regex: true, caseSensitive: false })).toEqual({ kind: "invalid", message: expect.stringMatching(/^Invalid regular expression: \w/) });
  expect(await find({ text: "call(", regex: true, caseSensitive: false }, notes.id)).toEqual({ kind: "invalid", message: expect.stringMatching(/^Invalid regular expression/) });
  expect(await find(literal("call("), notes.id)).toMatchObject({ kind: "matches", groups: [{ path: "ideas.md" }] });
});

it("keeps at most 100 lines from one file and 2,000 in all, and says more matched", async () => {
  const notes = await workspaceThread(Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`notes-${String(index).padStart(2, "0")}.md`, many(101, "needle")])));
  const walked = await find(literal("needle"), notes.id);
  expect(walked).toMatchObject({ kind: "matches", truncated: true });
  expect(walked.kind === "matches" && walked.groups.map((group) => group.lines.length)).toEqual([...Array.from({ length: 20 }, () => 100)]);
  await writeFile(path.join(checkout, "src", "lock.json"), many(150, "needle"));
  const grepped = await find(literal("needle"));
  expect(grepped).toMatchObject({ kind: "matches", truncated: true });
  expect(grepped.kind === "matches" && grepped.groups.map((group) => [group.path, group.lines.length])).toEqual([
    ["src/cart.ts", 1],
    ["src/lock.json", 100],
  ]);
});

it("shows a line from just before its match, without its indentation or line ending", async () => {
  await writeFile(path.join(checkout, "src", "long.ts"), `\t\tconst short = needle;\r\n${"a".repeat(300)} needle ${"b".repeat(400)}\n`);
  const result = await find(literal("needle"));
  const lines = result.kind === "matches" ? result.groups.find((group) => group.path === "src/long.ts")?.lines : undefined;
  expect(lines?.[0]).toEqual({ line: 1, text: "const short = needle;" });
  expect(lines?.[1]?.text).toMatch(/^…a{39} needle b+…$/);
  expect(lines?.[1]?.text.length).toBe(242);
});

/** A `git` first on PATH for one test. It logs each grep's pid and can hang the next grep; everything else reaches the real git. */
async function fakeGit() {
  const bin = await mkdtemp(path.join(os.tmpdir(), "openorc-find-git-"));
  const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const script = [
    "#!/bin/sh",
    'for arg in "$@"; do',
    '  if [ "$arg" = grep ]; then',
    `    echo $$ >> "${bin}/greps"`,
    `    if [ -e "${bin}/hang" ]; then rm "${bin}/hang"; exec sleep 30; fi`,
    "  fi",
    "done",
    `exec "${realGit}" "$@"`,
  ];
  await writeFile(path.join(bin, "git"), script.join("\n") + "\n");
  await chmod(path.join(bin, "git"), 0o755);
  const previous = process.env["PATH"];
  process.env["PATH"] = `${bin}:${previous ?? ""}`;
  return {
    hangNextGrep: () => writeFile(path.join(bin, "hang"), ""),
    greps: async () => (await readFile(path.join(bin, "greps"), "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number),
    restore: async () => {
      process.env["PATH"] = previous;
      await rm(bin, { recursive: true, force: true });
    },
  };
}

it("stops a find when a newer one for the same conversation starts, ending its git process", async () => {
  const git = await fakeGit();
  try {
    await git.hangNextGrep();
    const first = find(literal("needle"));
    const [pid] = await vi.waitFor(async () => {
      const greps = await git.greps();
      if (!greps.length) throw new Error("no grep yet");
      return greps;
    });
    const second = await find(literal("needle"));
    expect(await first).toEqual({ kind: "superseded" });
    expect(second).toMatchObject({ kind: "matches", groups: [{ path: "src/cart.ts" }] });
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    await git.restore();
  }
});
