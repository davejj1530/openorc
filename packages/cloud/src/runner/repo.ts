import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
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

interface SeedTarget {
  repo: string;
  branch: string;
  origin?: string;
}

/** The branch with its history, and the Mac's uncommitted work when there is some. */
interface SeedFromBundle extends SeedTarget {
  bundle: string;
  /** The bundle's ref for the branch, when it is not the branch itself. */
  ref?: string;
  /** A commit whose files are the Mac's uncommitted work, on top of the branch. */
  workRef?: string;
}

/** One commit and its files, none of its history: `history` brings that after. */
interface SeedFromPack extends SeedTarget {
  pack: string;
  commit: string;
}

export type SeedRequest = SeedFromBundle | SeedFromPack;

/** Stores the objects of a pack the Mac sent, then deletes the file. */
function takePack(repo: string, pack: string): void {
  const input = openSync(pack, "r");
  try {
    execFileSync("git", ["index-pack", "--stdin"], { cwd: repo, stdio: [input, "ignore", "pipe"] });
  } finally {
    closeSync(input);
  }
  rmSync(pack, { force: true });
}

const shallowFile = (repo: string) => path.resolve(repo, git(repo, ["rev-parse", "--git-path", "shallow"]));

function shallowCommits(repo: string): string[] {
  try {
    return readFileSync(shallowFile(repo), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Rewrites the commits whose parents this checkout lacks, under Git's own lock for that file. */
function changeShallow(repo: string, change: (commits: string[]) => string[]): string[] {
  const file = shallowFile(repo);
  const lock = `${file}.lock`;
  const held = openSync(lock, "wx");
  try {
    const next = change(shallowCommits(repo));
    writeSync(held, next.map((commit) => `${commit}\n`).join(""));
    if (next.length) renameSync(lock, file);
    else rmSync(file, { force: true });
    return next;
  } finally {
    closeSync(held);
    rmSync(lock, { force: true });
  }
}

/**
 * Makes the workspace's checkout from what the Mac sent. Only a workspace that never became ready is seeded, so no
 * agent has worked in a checkout already here: a seed that is tried again replaces it.
 */
export function seed(request: SeedRequest): { seeded: true } {
  const { repo, branch, origin } = request;
  const workRef = "bundle" in request ? request.workRef : undefined;
  const building = `${repo}.seeding`;
  rmSync(building, { recursive: true, force: true });
  mkdirSync(building, { recursive: true });
  git(building, ["init", "-q"]);
  if ("pack" in request) {
    takePack(building, request.pack);
    changeShallow(building, () => [request.commit]);
    git(building, ["update-ref", `refs/heads/${branch}`, request.commit]);
  } else {
    // The new repository's unborn HEAD may already name the branch, as it does wherever Git starts on that name.
    git(building, ["fetch", "-q", "--update-head-ok", request.bundle, `${request.ref ?? `refs/heads/${branch}`}:refs/heads/${branch}`, ...(workRef ? [`${workRef}:${SEED_REF}`] : [])]);
  }
  git(building, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  git(building, ["read-tree", "-u", "--reset", workRef ? SEED_REF : "HEAD"]);
  // The index goes back to the branch, so the Mac's uncommitted work stays uncommitted here too.
  if (workRef) git(building, ["reset", "-q", "--mixed"]);
  if (origin) git(building, ["remote", "add", "origin", origin]);
  rmSync(repo, { recursive: true, force: true });
  renameSync(building, repo);
  return { seeded: true };
}

export interface SeedOverRequest {
  repo: string;
  branch: string;
  /** The commit the new workspace starts at. */
  commit: string;
  /** Brings the commits the base lacks, under `ref`; none when it has the commit already. */
  bundle?: string;
  ref?: string;
  /** The commit and its files alone, when the base holds too little history for `bundle` to reach it. */
  pack?: string;
  origin?: string;
}

const START_REF = "refs/openorc/sync/start";

/**
 * Moves a base's checkout to the commit a new workspace starts at, on its own branch. What the base's setup left in
 * files Git ignores, such as installed dependencies, stays; tracked files become the commit's exactly.
 */
export function seedOver(request: SeedOverRequest): { seeded: true } {
  const { repo, branch, commit, bundle, ref, pack, origin } = request;
  if (pack) {
    takePack(repo, pack);
    changeShallow(repo, (commits) => [...new Set([...commits, commit])]);
  }
  if (bundle && ref) git(repo, ["fetch", "-q", bundle, `${ref}:${START_REF}`]);
  git(repo, ["checkout", "-q", "-f", "-B", branch, commit]);
  if (bundle && ref) git(repo, ["update-ref", "-d", START_REF]);
  if (origin) git(repo, git(repo, ["remote"]).split("\n").includes("origin") ? ["remote", "set-url", "origin", origin] : ["remote", "add", "origin", origin]);
  return { seeded: true };
}

/**
 * The history a checkout seeded from single commits lacks. Without a bundle, says which commits still end its history
 * here; with one, takes the bundle's objects and lets go of each such commit whose parents are all here now.
 */
export function history(repo: string, bundle?: string): { shallow: string[] } {
  if (!bundle) return { shallow: shallowCommits(repo) };
  git(repo, ["bundle", "unbundle", bundle]);
  rmSync(bundle, { force: true });
  // The commit object itself names its parents; the shallow list only hides them.
  const parents = (commit: string) =>
    git(repo, ["cat-file", "commit", commit])
      .split("\n\n")[0]!
      .split("\n")
      .filter((line) => line.startsWith("parent "))
      .map((line) => line.slice(7));
  const whole = (commit: string) => parents(commit).every((parent) => maybeGit(repo, ["cat-file", "-e", `${parent}^{commit}`]) !== null);
  return { shallow: changeShallow(repo, (commits) => commits.filter((commit) => !whole(commit))) };
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

/** A private index that persists between syncs, so unchanged files are not hashed again. */
const syncIndex = (state: string) => ({ GIT_INDEX_FILE: path.join(state, "sync.index") });

/**
 * The working tree's files as a tree, untracked files included and ignored ones left out, held in the private index.
 * The index starts from HEAD, so a committed file stays in when an ignore rule matches it, as it does for Git and for
 * the Mac's own copy. Entries that still match HEAD keep their cached stats.
 */
function workingTree(repo: string, state: string, head: string | null): string {
  const index = syncIndex(state);
  git(repo, head ? ["read-tree", "--reset", head] : ["read-tree", "--empty"], index);
  git(repo, ["add", "-A"], index);
  return git(repo, ["write-tree"], index);
}

/** Moves the checkout to the Mac's commit and files: commits, undos and edits made there between turns. */
export function apply(repo: string, state: string, request: ApplyRequest): { applied: boolean; tree: string } {
  const index = syncIndex(state);
  const current = workingTree(repo, state, maybeGit(repo, ["rev-parse", "-q", "--verify", "HEAD"]));
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
  const head = maybeGit(repo, ["rev-parse", "-q", "--verify", "HEAD"]);
  const tree = workingTree(repo, state, head);
  const branch = maybeGit(repo, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const commit = git(repo, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "OpenOrc cloud snapshot"], SNAPSHOT_IDENTITY);
  git(repo, ["update-ref", SNAPSHOT_REF, commit]);
  const have = known.filter((sha) => maybeGit(repo, ["cat-file", "-e", `${sha}^{commit}`]) !== null);
  if (have.includes(commit)) return { snapshot: commit, tree, head, branch, bundle: null };
  const bundle = path.join(state, "sync.bundle");
  git(repo, ["bundle", "create", "-q", bundle, SNAPSHOT_REF, ...have.map((sha) => `^${sha}`)]);
  return { snapshot: commit, tree, head, branch, bundle };
}
