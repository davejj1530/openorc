import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { git } from "./exec.js";
import { commitAll } from "./publish.js";
import { treeHash } from "./snapshot.js";
import { applyWork, packWork, type WorkSnapshot } from "./work-bundle.js";

const REFS = "refs/openorc/work/t1/";
let root: string;
let mac: string;
let far: string;

const out = async (cwd: string, ...args: string[]) => (await git(cwd, args)).stdout.trim();
const read = (folder: string, file: string) => readFileSync(path.join(folder, file), "utf8");

/** The far side, played by a second repository and plain Git: takes a bundle's work as its files, uncommitted. */
async function farTakes(file: string, ref: string, branch?: string): Promise<void> {
  await git(far, ["fetch", "-q", "--no-tags", file, `+${ref}:${ref}`, ...(branch ? [`+refs/heads/${branch}:refs/heads/${branch}`] : [])]);
  if (branch) await git(far, ["checkout", "-q", branch]);
  await git(far, ["restore", `--source=${ref}`, "--worktree", "--", "."]);
}

/** The far side's files as one commit, bundled without what `known` already holds, as it would send them back. */
async function farSnapshot(known: string[]): Promise<WorkSnapshot> {
  const tree = await treeHash(far);
  const head = await out(far, "rev-parse", "HEAD");
  const snapshot = (
    await git(far, ["commit-tree", tree, "-p", head, "-m", "snapshot"], {
      env: { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
    })
  ).stdout.trim();
  await git(far, ["update-ref", "refs/openorc/snapshot", snapshot]);
  const file = path.join(root, `back-${Date.now()}-${Math.random().toString(16).slice(2)}.bundle`);
  await git(far, ["bundle", "create", "-q", file, "refs/openorc/snapshot", ...known.map((sha) => `^${sha}`)]);
  return { snapshot, tree, head, bundle: { file, from: "refs/openorc/snapshot" } };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-work-bundle-")));
  mac = path.join(root, "mac");
  far = path.join(root, "far");
  await git(root, ["init", "-q", "-b", "main", mac]);
  writeFileSync(path.join(mac, "README.md"), "# App\n");
  writeFileSync(path.join(mac, ".gitignore"), "node_modules/\n");
  await commitAll(mac, "Baseline");
  await git(mac, ["checkout", "-q", "-b", "openorc/feature"]);
  writeFileSync(path.join(mac, "feature.md"), "committed on the branch\n");
  await commitAll(mac, "Feature");
  await git(root, ["init", "-q", "-b", "main", far]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("packs a branch with its history and the folder's uncommitted and untracked work, touching nothing here", async () => {
  writeFileSync(path.join(mac, "README.md"), "# App, edited and not committed\n");
  writeFileSync(path.join(mac, "untracked.md"), "never added\n");
  writeFileSync(path.join(mac, "staged.md"), "staged only\n");
  await git(mac, ["add", "staged.md"]);
  const before = { head: await out(mac, "rev-parse", "HEAD"), branch: await out(mac, "symbolic-ref", "--short", "HEAD"), status: await out(mac, "status", "--porcelain") };
  const file = path.join(root, "seed.bundle");

  const packed = await packWork(mac, { ref: `${REFS}seed`, file, branch: "openorc/feature" });

  expect(packed).toEqual({ work: await out(mac, "rev-parse", `${REFS}seed`), head: before.head, tree: await treeHash(mac) });
  expect({ head: await out(mac, "rev-parse", "HEAD"), branch: await out(mac, "symbolic-ref", "--short", "HEAD"), status: await out(mac, "status", "--porcelain") }).toEqual(before);

  await farTakes(file, `${REFS}seed`, "openorc/feature");
  expect(await out(far, "rev-parse", "HEAD")).toBe(before.head);
  expect(await out(far, "log", "--format=%s")).toBe("Feature\nBaseline");
  expect(read(far, "README.md")).toBe("# App, edited and not committed\n");
  expect(read(far, "untracked.md")).toBe("never added\n");
  expect(read(far, "staged.md")).toBe("staged only\n");
  // It arrives as work in progress, not as a commit.
  expect(await out(far, "status", "--porcelain")).toContain("untracked.md");
});

it("leaves out the history the other side already holds", async () => {
  writeFileSync(path.join(mac, "big.bin"), randomBytes(512 * 1024));
  await commitAll(mac, "A large file in the branch's history");
  const first = path.join(root, "first.bundle");
  const { work } = await packWork(mac, { ref: `${REFS}seed`, file: first, branch: "openorc/feature" });
  expect(statSync(first).size).toBeGreaterThan(512 * 1024);
  await farTakes(first, `${REFS}seed`, "openorc/feature");
  writeFileSync(path.join(mac, "small.md"), "one more line\n");
  const next = path.join(root, "next.bundle");

  // A commit this repository has never seen is passed over, not refused.
  const packed = await packWork(mac, { ref: `${REFS}push`, file: next, known: [work, "0000000000000000000000000000000000000000"] });

  expect(statSync(next).size).toBeLessThan(4096);
  await farTakes(next, `${REFS}push`);
  expect(read(far, "small.md")).toBe("one more line\n");
  expect(await out(far, "rev-parse", `${REFS}push^{tree}`)).toBe(packed.tree);
});

it("brings the other side's files and commits back, keeping what was edited and committed here meanwhile", async () => {
  const file = path.join(root, "seed.bundle");
  const sent = await packWork(mac, { ref: `${REFS}seed`, file, branch: "openorc/feature" });
  await farTakes(file, `${REFS}seed`, "openorc/feature");
  writeFileSync(path.join(far, "agent.md"), "written over there\n");
  await commitAll(far, "Agent's commit");
  writeFileSync(path.join(far, "draft.md"), "not committed over there\n");
  // Meanwhile on the Mac: an edit, and a commit the other side never got.
  writeFileSync(path.join(mac, "local.md"), "committed here meanwhile\n");
  const localCommit = await commitAll(mac, "Local commit");
  writeFileSync(path.join(mac, "README.md"), "# App, edited here meanwhile\n");
  writeFileSync(path.join(mac, "node_modules.keep"), "kept\n");
  const snapshot = await farSnapshot([sent.work]);

  const applied = await applyWork(mac, snapshot, { refs: REFS, matched: sent.tree });

  expect(applied.changed).toBe(true);
  expect(read(mac, "agent.md")).toBe("written over there\n");
  expect(read(mac, "draft.md")).toBe("not committed over there\n");
  expect(read(mac, "README.md")).toBe("# App\n");
  expect(existsSync(path.join(mac, "local.md"))).toBe(false);
  expect(await out(mac, "rev-parse", "HEAD")).toBe(snapshot.head);
  expect(await out(mac, "symbolic-ref", "--short", "HEAD")).toBe("openorc/feature");
  expect(await treeHash(mac)).toBe(snapshot.tree);
  // Nothing made here is lost: the edit and the commit are under refs.
  expect(await out(mac, "show", `${applied.keptEdits}:README.md`)).toBe("# App, edited here meanwhile");
  expect(await out(mac, "rev-parse", applied.keptCommit!)).toBe(localCommit);
});

it("changes nothing when the other side holds what this folder does", async () => {
  const file = path.join(root, "seed.bundle");
  const sent = await packWork(mac, { ref: `${REFS}seed`, file, branch: "openorc/feature" });
  await farTakes(file, `${REFS}seed`, "openorc/feature");
  const snapshot = await farSnapshot([sent.work]);

  expect(await applyWork(mac, { ...snapshot, bundle: snapshot.bundle }, { refs: REFS, matched: sent.tree })).toEqual({ changed: false, keptEdits: null, keptCommit: null });
  // Told there is nothing to fetch, it pins what it already has.
  expect(await applyWork(mac, { ...snapshot, snapshot: sent.work, bundle: null }, { refs: REFS, matched: sent.tree })).toEqual({ changed: false, keptEdits: null, keptCommit: null });
  expect(await out(mac, "rev-parse", `${REFS}snapshot`)).toBe(sent.work);
});
