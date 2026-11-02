import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git, pinObject, switchFiles, treeHash } from "@openorc/git";
import { runRunner, type RunnerInstall } from "./runner-client.js";
import { SNAPSHOT_REF, type SnapshotResult } from "./runner/repo.js";

const WORK_IDENTITY = {
  GIT_AUTHOR_NAME: "OpenOrc",
  GIT_AUTHOR_EMAIL: "cloud@openorc.app",
  GIT_COMMITTER_NAME: "OpenOrc",
  GIT_COMMITTER_EMAIL: "cloud@openorc.app",
};

/** What the Mac's copy of a cloud workspace last matched. */
export interface MirrorState {
  /** The last snapshot applied, or null before the first pull. */
  snapshot: string | null;
  /** The files the mirror held after the last seed or pull. */
  tree: string;
  /** Commits the Mac has, so a pull sends only what is new. */
  known: string[];
}

export interface WorkspaceLocation {
  install: RunnerInstall;
  /** The checkout in the VM. */
  repo: string;
  /** The folder on the Mac that mirrors it, a worktree of the user's repository. */
  mirror: string;
  /** Where this workspace keeps its refs on the Mac, ending in a slash. */
  refPrefix: string;
}

async function workingTreeCommit(cwd: string, parent: string): Promise<string | null> {
  const tree = await treeHash(cwd);
  const parentTree = (await git(cwd, ["rev-parse", `${parent}^{tree}`])).stdout.trim();
  if (tree === parentTree) return null;
  return (await git(cwd, ["commit-tree", tree, "-p", parent, "-m", "OpenOrc work in progress"], { env: WORK_IDENTITY })).stdout.trim();
}

/**
 * Makes the VM's checkout from the mirror: the branch with its history, plus uncommitted and untracked work, which
 * stays uncommitted in the VM. Nothing is pushed anywhere and the VM needs no Git credentials.
 */
export async function seedWorkspace(location: WorkspaceLocation, branch: string, origin?: string): Promise<MirrorState> {
  const { install, mirror, refPrefix, repo } = location;
  const current = (await git(mirror, ["symbolic-ref", "-q", "--short", "HEAD"], { okCodes: [0, 1] })).stdout.trim();
  if (current !== branch) throw new Error(`The folder for this cloud workspace is not on ${branch}.`);
  const head = (await git(mirror, ["rev-parse", "HEAD"])).stdout.trim();
  const work = await workingTreeCommit(mirror, head);
  const workRef = `${refPrefix}seed`;
  if (work) await pinObject(mirror, workRef, work);
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-seed-"));
  try {
    const bundle = path.join(dir, "seed.bundle");
    await git(mirror, ["bundle", "create", "-q", bundle, `refs/heads/${branch}`, ...(work ? [workRef] : [])]);
    const remoteBundle = path.posix.join(install.state, "seed.bundle");
    await install.sandbox.writeFile(remoteBundle, await readFile(bundle));
    const args = ["--repo", repo, "--bundle", remoteBundle, "--branch", branch, ...(work ? ["--work-ref", workRef] : []), ...(origin ? ["--origin", origin] : [])];
    await runRunner(install, "seed", args);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { snapshot: null, tree: await treeHash(mirror), known: work ? [work] : [head] };
}

export interface PullResult {
  state: MirrorState;
  changed: boolean;
  head: string | null;
  branch: string | null;
  /** Edits made in the mirror since the last pull. The pull replaced them; this ref keeps them. */
  keptLocalEdits: string | null;
  /** A commit made in the mirror that the sandbox's branch does not contain. The pull moved the branch; this ref keeps it. */
  keptLocalCommit: string | null;
}

async function fetchSnapshot(location: WorkspaceLocation, result: SnapshotResult): Promise<void> {
  const { install, mirror, refPrefix } = location;
  if (!result.bundle) {
    await pinObject(mirror, `${refPrefix}snapshot`, result.snapshot);
    return;
  }
  const content = await install.sandbox.readFile(result.bundle);
  if (!content) throw new Error("The cloud workspace's changes went missing before they reached the Mac.");
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-pull-"));
  try {
    const bundle = path.join(dir, "pull.bundle");
    await writeFile(bundle, content);
    await git(mirror, ["fetch", "-q", "--no-tags", bundle, `+${SNAPSHOT_REF}:${refPrefix}snapshot`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Moves the mirror's branch to the sandbox's commit. A commit made on the Mac that the sandbox lacks is kept under a ref first. */
async function followHead({ mirror, refPrefix }: WorkspaceLocation, head: string | null): Promise<{ moved: boolean; kept: string | null }> {
  const local = (await git(mirror, ["rev-parse", "HEAD"])).stdout.trim();
  if (head === null || local === head) return { moved: false, kept: null };
  let kept: string | null = null;
  if ((await git(mirror, ["merge-base", "--is-ancestor", local, head], { okCodes: [0, 1] })).code === 1) {
    kept = `${refPrefix}kept-commit/${Date.now()}`;
    await pinObject(mirror, kept, local);
  }
  await git(mirror, ["reset", "-q", "--mixed", head]);
  return { moved: true, kept };
}

/**
 * Brings the VM's files and commits to the mirror. Sync runs one way: the VM is the only writer. Edits made in the
 * mirror since the last pull are kept under a ref before they are replaced, never discarded. Ignored files such as
 * dependencies are left alone on both sides.
 */
export async function pullWorkspace(location: WorkspaceLocation, state: MirrorState): Promise<PullResult> {
  const { install, mirror, refPrefix, repo } = location;
  const result = await runRunner<SnapshotResult>(install, "snapshot", ["--repo", repo, ...state.known.flatMap((sha) => ["--known", sha])]);
  if (result.snapshot === state.snapshot) return { state, changed: false, head: result.head, branch: result.branch, keptLocalEdits: null, keptLocalCommit: null };
  await fetchSnapshot(location, result);
  const current = await treeHash(mirror);
  let keptLocalEdits: string | null = null;
  if (current !== state.tree) {
    const parent = (await git(mirror, ["rev-parse", "HEAD"])).stdout.trim();
    const kept = (await git(mirror, ["commit-tree", current, "-p", parent, "-m", "Edits made on the Mac while the cloud workspace owned these files"], { env: WORK_IDENTITY })).stdout.trim();
    keptLocalEdits = `${refPrefix}kept/${Date.now()}`;
    await pinObject(mirror, keptLocalEdits, kept);
  }
  if (current !== result.tree) await switchFiles(mirror, current, result.tree);
  const { moved, kept: keptLocalCommit } = await followHead(location, result.head);
  return {
    state: { snapshot: result.snapshot, tree: result.tree, known: [result.snapshot] },
    changed: moved || current !== result.tree,
    head: result.head,
    branch: result.branch,
    keptLocalEdits,
    keptLocalCommit,
  };
}
