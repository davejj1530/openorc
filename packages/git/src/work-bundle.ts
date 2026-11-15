import path from "node:path";
import { git } from "./exec.js";
import { pinObject } from "./refs.js";
import { switchFiles, treeHash } from "./snapshot.js";

/*
 * This Mac's half of carrying a folder's work to another copy of the repository and back, kept from the person's own
 * cloud for OpenOrc Cloud's "code from this Mac" (see .local-development/multiplayer/ui/cloud-parity/build/from-own-cloud.md).
 * Nothing in the app calls it today. The other side, which checks a bundle out and makes one of its own, is not here.
 */

const IDENTITY = { GIT_AUTHOR_NAME: "OpenOrc", GIT_AUTHOR_EMAIL: "cloud@openorc.app", GIT_COMMITTER_NAME: "OpenOrc", GIT_COMMITTER_EMAIL: "cloud@openorc.app" };

/** A folder's work as it was packed. */
export interface PackedWork {
  /** The folder's files, uncommitted and untracked included, as one commit on its head. */
  work: string;
  /** The commit the folder was on. */
  head: string;
  /** The files' tree: what the folder held when it was packed. */
  tree: string;
}

/**
 * Packs a folder's work into a bundle at `file`: its files as they are, uncommitted and untracked included, as one
 * commit on its head, pinned under `ref` so `git gc` keeps it. `branch` adds that branch's history, as a first send
 * does; `known` names commits the other side holds, whose history is left out (work not yet committed goes whole each
 * time). The folder's own head, index and files are not touched.
 */
export async function packWork(folder: string, options: { ref: string; file: string; branch?: string; known?: readonly string[] }): Promise<PackedWork> {
  const head = (await git(folder, ["rev-parse", "HEAD"])).stdout.trim();
  const tree = await treeHash(folder);
  const work = (await git(folder, ["commit-tree", tree, "-p", head, "-m", "OpenOrc work from the Mac"], { env: IDENTITY })).stdout.trim();
  await pinObject(folder, options.ref, work);
  const has = async (commit: string) => (await git(folder, ["cat-file", "-e", `${commit}^{commit}`], { okCodes: [0, 1, 128] })).code === 0;
  const known = [];
  for (const commit of options.known ?? []) if (await has(commit)) known.push(`^${commit}`);
  await git(folder, ["bundle", "create", "-q", options.file, ...(options.branch ? [`refs/heads/${options.branch}`] : []), options.ref, ...known]);
  return { work, head, tree };
}

/** What the other side holds now, as it says so. */
export interface WorkSnapshot {
  /** Its files as one commit. */
  snapshot: string;
  tree: string;
  /** The commit its branch is on; null when it has none. */
  head: string | null;
  /** A bundle holding `snapshot` under `from`; null when this repository has the commit already. */
  bundle: { file: string; from: string } | null;
}

/** What applying a snapshot did here. */
export interface AppliedWork {
  changed: boolean;
  /** Edits made here since the folder last matched; the snapshot replaced them, and this ref keeps them. */
  keptEdits: string | null;
  /** A commit made here that the snapshot's branch does not contain; the branch moved, and this ref keeps it. */
  keptCommit: string | null;
}

/**
 * Brings the other side's files and commits to a folder. The other side is the writer: edits made here since the folder
 * last held `matched` are kept under a ref before they are replaced, never discarded, and a commit made here that its
 * branch lacks is kept the same way. Refs go under `refs`, which ends in a slash. Ignored files are left alone.
 */
export async function applyWork(folder: string, snapshot: WorkSnapshot, options: { refs: string; matched: string }): Promise<AppliedWork> {
  const { refs } = options;
  if (snapshot.bundle) await git(folder, ["fetch", "-q", "--no-tags", "--no-write-fetch-head", path.resolve(snapshot.bundle.file), `+${snapshot.bundle.from}:${refs}snapshot`]);
  else await pinObject(folder, `${refs}snapshot`, snapshot.snapshot);
  const current = await treeHash(folder);
  const local = (await git(folder, ["rev-parse", "HEAD"])).stdout.trim();
  let keptEdits: string | null = null;
  if (current !== options.matched) {
    const edits = (await git(folder, ["commit-tree", current, "-p", local, "-m", "Edits made on the Mac while the cloud owned these files"], { env: IDENTITY })).stdout.trim();
    keptEdits = `${refs}kept/${Date.now()}`;
    await pinObject(folder, keptEdits, edits);
  }
  if (current !== snapshot.tree) await switchFiles(folder, current, snapshot.tree);
  let keptCommit: string | null = null;
  const moved = snapshot.head !== null && local !== snapshot.head;
  if (moved) {
    if ((await git(folder, ["merge-base", "--is-ancestor", local, snapshot.head!], { okCodes: [0, 1] })).code === 1) {
      keptCommit = `${refs}kept-commit/${Date.now()}`;
      await pinObject(folder, keptCommit, local);
    }
    await git(folder, ["reset", "-q", "--mixed", snapshot.head!]);
  }
  return { changed: moved || current !== snapshot.tree, keptEdits, keptCommit };
}
