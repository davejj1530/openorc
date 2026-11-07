import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { git } from "./exec.js";
import { commitRange } from "./repo.js";

let root: string;
const commit = async (file: string, text: string, message: string) => {
  await writeFile(path.join(root, file), text);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", message]);
  return (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
};

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-range-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await commit("a.txt", "a\n", "Start");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

it("reads a branch back to where it left its base, with the size of what it adds", async () => {
  const base = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  await git(root, ["switch", "-q", "-c", "feature"]);
  await commit("b.txt", "one\ntwo\n", "Add b");
  const tip = await commit("a.txt", "a\nmore\n", "Grow a");
  // main moves on after the branch left it; the branch's own commits stay the range.
  await git(root, ["switch", "-q", "main"]);
  await commit("c.txt", "c\n", "Main moves on");

  const range = await commitRange(root, { from: null, to: tip.slice(0, 7), base: "main" });
  expect(range?.commits.map((c) => c.subject)).toEqual(["Grow a", "Add b"]);
  expect(range?.start).toMatchObject({ sha: base, subject: "Start" });
  expect(range?.base).toBe("main");
  expect(range?.stat).toEqual({ files: 2, added: 3, removed: 0 });
  expect(range?.more).toBe(0);
});

it("reads what a push moved from its old tip, and counts what the limit leaves out", async () => {
  const from = (await git(root, ["rev-parse", "main"])).stdout.trim();
  await commit("d.txt", "d\n", "One");
  await commit("e.txt", "e\n", "Two");
  const to = await commit("f.txt", "f\n", "Three");
  const range = await commitRange(root, { from, to, base: null, limit: 2 });
  expect(range?.commits.map((c) => c.subject)).toEqual(["Three", "Two"]);
  expect(range?.more).toBe(1);
  expect(range?.start?.sha).toBe(from);
  expect(range?.base).toBeNull();
});

it("says nothing for a commit the repository does not have", async () => {
  expect(await commitRange(root, { from: null, to: "deadbee", base: "main" })).toBeNull();
});
