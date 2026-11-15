import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Db, projects } from "@openorc/db";
import { commitAll, git, worktree } from "@openorc/git";
import type { MirrorSnapshot, Project } from "@openorc/protocol";
import { BrainMirrors, closeMirror, mirrorFolder, snapshotFolder, type MirrorDeps } from "./brain-mirrors.js";

const THREAD = "far-thread";
const FAR_PROJECT = "far-project";

let root: string;
let db: Db;
let checkout: string;
let farCopy: string;
let farFolder: string;
let macProject: Project;
let logged: string[];
let changed: string[];
let snapshots: MirrorSnapshot[];

/** The copy's deps with the far side played by a clone on this disk, which is all `snapshotFolder` needs. */
function mirrors(overrides: Partial<MirrorDeps> = {}): BrainMirrors {
  return new BrainMirrors({
    db,
    dataDir: path.join(root, "data"),
    snapshot: async (threadId, known) => {
      const snapshot = await snapshotFolder(farCopy, farFolder, threadId, known);
      snapshots.push(snapshot);
      return snapshot;
    },
    thread: async () => ({ projectId: FAR_PROJECT, baseSha: null }),
    macProject: async (farProject) => (farProject === FAR_PROJECT ? macProject.id : null),
    changed: (threadId) => void changed.push(threadId),
    log: { info: (message) => void logged.push(message), warn: (message) => void logged.push(message), error: (message) => void logged.push(message) },
    ...overrides,
  });
}

const keptRefs = async () => (await git(checkout, ["for-each-ref", "--format=%(refname) %(objectname)", `refs/openorc/mirror/${THREAD}/kept/`])).stdout.split("\n").filter(Boolean);

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-mirrors-")));
  [logged, changed, snapshots] = [[], [], []];
  checkout = path.join(root, "app");
  await git(root, ["init", "-q", "-b", "main", checkout]);
  writeFileSync(path.join(checkout, "README.md"), "# Mirror\n");
  // History both sides share, too large to send again.
  writeFileSync(path.join(checkout, "assets.bin"), randomBytes(2 * 1024 * 1024));
  await commitAll(checkout, "Baseline");
  farCopy = path.join(root, "far-copy");
  await git(root, ["clone", "-q", checkout, farCopy]);
  farFolder = path.join(root, "far-worktree");
  await worktree.add(farCopy, { path: farFolder, branch: "openorc/far", startPoint: "main" });
  writeFileSync(path.join(farFolder, "feature.md"), "committed over there\n");
  await commitAll(farFolder, "Far work");
  writeFileSync(path.join(farFolder, "draft.md"), "not committed yet\n");
  db = Db.memory();
  macProject = projects.insert(db, { name: "app", rootPath: checkout, gitRemote: null, defaultBranch: "main", settings: {} });
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

it("opens a thread's code on this Mac, uncommitted work included, and keeps it current one way", async () => {
  const copies = mirrors();
  await copies.open(THREAD);
  const copy = copies.folder(THREAD)!;
  expect(copies.isOpen(THREAD)).toBe(true);
  expect(mirrorFolder(db, THREAD)).toEqual({ path: copy, projectId: macProject.id });
  expect(readFileSync(path.join(copy, "feature.md"), "utf8")).toBe("committed over there\n");
  expect(readFileSync(path.join(copy, "draft.md"), "utf8")).toBe("not committed yet\n");
  // An edit made in the copy here is kept aside, and never reaches the far side.
  writeFileSync(path.join(copy, "draft.md"), "edited on the Mac\n");
  writeFileSync(path.join(farFolder, "agent.md"), "written by the agent\n");
  await copies.pull(THREAD);
  expect(readFileSync(path.join(copy, "agent.md"), "utf8")).toBe("written by the agent\n");
  expect(readFileSync(path.join(copy, "draft.md"), "utf8")).toBe("not committed yet\n");
  expect(readFileSync(path.join(farFolder, "draft.md"), "utf8")).toBe("not committed yet\n");
  const [kept] = await keptRefs();
  expect((await git(checkout, ["show", `${kept!.split(" ")[1]}:draft.md`])).stdout).toBe("edited on the Mac\n");
  await copies.close(THREAD);
  expect(existsSync(copy)).toBe(false);
  expect(copies.isOpen(THREAD)).toBe(false);
  expect(changed.at(-1)).toBe(THREAD);
});

it("keeps edits made in the copy aside when it closes, and says where", async () => {
  const copies = mirrors();
  await copies.open(THREAD);
  const copy = copies.folder(THREAD)!;
  writeFileSync(path.join(copy, "draft.md"), "edited on the Mac before closing\n");
  await copies.close(THREAD);
  expect(existsSync(copy)).toBe(false);
  const refs = await keptRefs();
  expect(refs).toEqual([expect.stringMatching(new RegExp(`^refs/openorc/mirror/${THREAD}/kept/\\d+ [0-9a-f]{40}$`))]);
  const [ref, kept] = refs[0]!.split(" ");
  expect((await git(checkout, ["show", `${kept}:draft.md`])).stdout).toBe("edited on the Mac before closing\n");
  expect(logged).toContainEqual(expect.stringContaining(ref!));
  // A copy closed untouched keeps nothing.
  await copies.open(THREAD);
  await copies.close(THREAD);
  expect(await keptRefs()).toEqual(refs);
});

it("brings only what this Mac lacks the first time a thread opens here", async () => {
  await mirrors().open(THREAD);
  expect(Buffer.from(snapshots[0]!.bundle!, "base64").length).toBeLessThan(256 * 1024);
});

it("refuses a thread whose project is not on this Mac", async () => {
  await expect(mirrors({ macProject: async () => null }).open(THREAD)).rejects.toThrow("This conversation's project is not on this Mac.");
  expect(mirrorFolder(db, THREAD)).toBeNull();
});

it("leaves a copy closed when it closes while a refresh waits on the far side", async () => {
  let answer: () => void = () => {};
  let waiting = false;
  const copies = mirrors({
    snapshot: async (threadId, known) => {
      if (waiting) await new Promise<void>((resolve) => (answer = resolve));
      return snapshotFolder(farCopy, farFolder, threadId, known);
    },
  });
  await copies.open(THREAD);
  const copy = copies.folder(THREAD)!;
  writeFileSync(path.join(farFolder, "agent.md"), "written by the agent\n");
  waiting = true;
  const pulled = copies.pull(THREAD);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await closeMirror(db, THREAD, { info: () => {} });
  answer();
  await pulled;
  expect(mirrorFolder(db, THREAD)).toBeNull();
  expect(existsSync(copy)).toBe(false);
});
