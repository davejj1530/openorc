import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

/** Snapshot commits carry fixed metadata, so the same files on the same commit always make the same snapshot. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "OpenOrc",
  GIT_AUTHOR_EMAIL: "cloud@openorc.app",
  GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "OpenOrc",
  GIT_COMMITTER_EMAIL: "cloud@openorc.app",
  GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
};
export const SNAPSHOT_REF = "refs/openorc/sync/snapshot";
const SEED_REF = "refs/openorc/sync/seed";
const INCOMING_REF = "refs/openorc/sync/incoming";

function git(repo: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function maybeGit(repo: string, args: string[]): string | null {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}

export interface SeedRequest {
  repo: string;
  bundle: string;
  branch: string;
  /** The bundle's ref for the branch, when it is not the branch itself. */
  ref?: string;
  /** A commit whose files are the Mac's uncommitted work, on top of the branch. */
  workRef?: string;
  origin?: string;
}

/**
 * Makes the workspace's checkout from a bundle the Mac sent. Only a workspace that never became ready is seeded, so no
 * agent has worked in a checkout already here: a seed that is tried again replaces it.
 */
export function seed(request: SeedRequest): { seeded: true } {
  const { repo, bundle, branch, workRef, origin } = request;
  const building = `${repo}.seeding`;
  rmSync(building, { recursive: true, force: true });
  mkdirSync(building, { recursive: true });
  git(building, ["init", "-q"]);
  // The new repository's unborn HEAD may already name the branch, as it does wherever Git starts on that name.
  git(building, ["fetch", "-q", "--update-head-ok", bundle, `${request.ref ?? `refs/heads/${branch}`}:refs/heads/${branch}`, ...(workRef ? [`${workRef}:${SEED_REF}`] : [])]);
  git(building, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  git(building, ["read-tree", "-u", "--reset", workRef ? SEED_REF : "HEAD"]);
  // The index goes back to the branch, so the Mac's uncommitted work stays uncommitted here too.
  if (workRef) git(building, ["reset", "-q", "--mixed"]);
  if (origin) git(building, ["remote", "add", "origin", origin]);
  rmSync(repo, { recursive: true, force: true });
  renameSync(building, repo);
  return { seeded: true };
}

export interface SnapshotResult {
  snapshot: string;
  tree: string;
  head: string | null;
  branch: string | null;
  /** Null when the Mac already has the snapshot. */
  bundle: string | null;
}

export interface ApplyRequest {
  bundle: string;
  /** A commit in the bundle: its files are the Mac's, its parent is the Mac's HEAD. */
  ref: string;
  /** The files the Mac last saw here. When the checkout has moved on since, nothing is applied. */
  expectTree: string;
}

/** Moves the checkout to the Mac's commit and files: commits, undos and edits made there between turns. */
export function apply(repo: string, state: string, request: ApplyRequest): { applied: boolean; tree: string } {
  const index = { GIT_INDEX_FILE: path.join(state, "sync.index") };
  git(repo, ["add", "-A"], index);
  const current = git(repo, ["write-tree"], index);
  if (current !== request.expectTree) return { applied: false, tree: current };
  git(repo, ["fetch", "-q", "--no-tags", request.bundle, `+${request.ref}:${INCOMING_REF}`]);
  const tree = git(repo, ["rev-parse", `${INCOMING_REF}^{tree}`]);
  // The private index holds exactly `current`, so Git moves the files the way a checkout would.
  git(repo, ["read-tree", "-m", "-u", current, tree], index);
  git(repo, ["reset", "-q", "--mixed", `${INCOMING_REF}^`]);
  return { applied: true, tree };
}

/**
 * Records the working tree, untracked files included and ignored ones left out, as a commit on top of HEAD. The
 * bundle holds what the Mac lacks: everything reachable from the snapshot except the commits it says it has.
 */
export function snapshot(repo: string, state: string, known: string[]): SnapshotResult {
  // A private index that persists between snapshots, so unchanged files are not hashed again.
  const index = { GIT_INDEX_FILE: path.join(state, "sync.index") };
  git(repo, ["add", "-A"], index);
  const tree = git(repo, ["write-tree"], index);
  const head = maybeGit(repo, ["rev-parse", "-q", "--verify", "HEAD"]);
  const branch = maybeGit(repo, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const commit = git(repo, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "OpenOrc cloud snapshot"], SNAPSHOT_IDENTITY);
  git(repo, ["update-ref", SNAPSHOT_REF, commit]);
  const have = known.filter((sha) => maybeGit(repo, ["cat-file", "-e", `${sha}^{commit}`]) !== null);
  if (have.includes(commit)) return { snapshot: commit, tree, head, branch, bundle: null };
  const bundle = path.join(state, "sync.bundle");
  git(repo, ["bundle", "create", "-q", bundle, SNAPSHOT_REF, ...have.map((sha) => `^${sha}`)]);
  return { snapshot: commit, tree, head, branch, bundle };
}
