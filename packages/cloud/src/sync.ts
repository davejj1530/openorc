import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git, gitToFile, pinObject, switchFiles, treeHash } from "@openorc/git";
import { runRunner, type RunnerInstall } from "./runner-client.js";
import { SNAPSHOT_REF, type SnapshotResult } from "./runner/repo.js";
import type { HarnessId } from "@openorc/protocol";

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
  /** The files the mirror held after the last sync. */
  tree: string;
  /** The commit the mirror was on after the last sync. */
  head: string | null;
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

async function workingTreeCommit(cwd: string, parent: string, tree: string): Promise<string | null> {
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
  const tree = await treeHash(mirror);
  const work = await workingTreeCommit(mirror, head, tree);
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
  return { snapshot: null, tree, head, known: work ? [work] : [head] };
}

/** Times each step of a seed, as a cloud start's log line names them. */
export interface SeedSteps {
  time<T>(name: string, work: () => Promise<T>): Promise<T>;
}

const UNTIMED: SeedSteps = { time: (_name, work) => work() };

async function inTemp<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-seed-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Puts a file from this host in the sandbox's state folder, and says where. */
async function send(install: RunnerInstall, file: string, name: string): Promise<string> {
  const remote = path.posix.join(install.state, name);
  await install.sandbox.writeFile(remote, await readFile(file));
  return remote;
}

/** A pack in `dir` of the commit and its files, none of its history: what a checkout starts from before its history. */
async function tipPack(source: string, commit: string, dir: string): Promise<string> {
  const objects = (await git(source, ["rev-list", "--objects", "--no-object-names", "--max-count=1", commit])).stdout;
  const pack = path.join(dir, "tip.pack");
  await gitToFile(source, ["pack-objects", "-q", "--stdout"], pack, { input: objects });
  return pack;
}

/**
 * Makes the VM's checkout for a new conversation from the commit its worktree starts at, without waiting for the
 * worktree: a new worktree holds exactly that commit's files. `source` is the repository the worktree belongs to. Only
 * the commit and its files go up, so the agent can start; `fillHistory` brings the history after.
 */
export async function seedFromCommit(location: WorkspaceLocation, start: { source: string; commit: string; branch: string; origin?: string }, steps = UNTIMED): Promise<MirrorState> {
  const { install, repo } = location;
  await inTemp(async (dir) => {
    const pack = await steps.time("pack", () => tipPack(start.source, start.commit, dir));
    const remote = await steps.time("upload", () => send(install, pack, "seed.pack"));
    const args = ["--repo", repo, "--pack", remote, "--commit", start.commit, "--branch", start.branch, ...(start.origin ? ["--origin", start.origin] : [])];
    await steps.time("checkout", () => runRunner(install, "seed", args));
  });
  const tree = (await git(start.source, ["rev-parse", `${start.commit}^{tree}`])).stdout.trim();
  return { snapshot: null, tree, head: start.commit, known: [start.commit] };
}

/**
 * Fills in the history of a checkout seeded from single commits: the sandbox says which commits still end its history
 * there, and the history of each that `source` has goes up in one bundle. True when there was any to send.
 */
export async function fillHistory(location: WorkspaceLocation, source: string): Promise<boolean> {
  const { install, refPrefix, repo } = location;
  const { shallow } = await runRunner<{ shallow: string[] }>(install, "history", ["--repo", repo]);
  const isCommit = async (commit: string) => (await git(source, ["cat-file", "-e", `${commit}^{commit}`], { okCodes: [0, 1, 128] })).code === 0;
  const ends = (await Promise.all(shallow.map(async (commit) => ((await isCommit(commit)) ? commit : null)))).filter((commit) => commit !== null);
  if (!ends.length) return false;
  const refs = ends.map((_commit, index) => `${refPrefix}history/${index}`);
  try {
    await Promise.all(ends.map((commit, index) => pinObject(source, refs[index]!, commit)));
    await inTemp(async (dir) => {
      const bundle = path.join(dir, "history.bundle");
      await git(source, ["bundle", "create", "-q", bundle, ...refs]);
      await runRunner(install, "history", ["--repo", repo, "--bundle", await send(install, bundle, "history.bundle")]);
    });
  } finally {
    await Promise.all(refs.map((ref) => git(source, ["update-ref", "-d", ref], { okCodes: [0, 1, 128] })));
  }
  return true;
}

/** How a new conversation's commit gets over a base's checkout. */
type OverBase = "nothing" | "commits" | "history" | "files";

async function overBase(source: string, commit: string, base: string, shallow: boolean): Promise<OverBase> {
  if (commit === base) return "nothing";
  const known = (await git(source, ["cat-file", "-e", `${base}^{commit}`], { okCodes: [0, 1, 128] })).code === 0;
  if (!shallow) {
    // A commit the base's own checkout already has needs nothing sent; all of the branch's history only when this
    // repository no longer has the base's commit, as after a force push.
    if (!known) return "history";
    return (await git(source, ["merge-base", "--is-ancestor", commit, base], { okCodes: [0, 1, 128] })).code === 0 ? "nothing" : "commits";
  }
  // A base without its history has only its own commit, so commits go up only when everything they need is that one.
  if (!known) return "files";
  const listed = (await git(source, ["rev-list", "--boundary", commit, `^${base}`])).stdout.split("\n").filter(Boolean);
  const needs = listed.filter((line) => line.startsWith("-")).map((line) => line.slice(1));
  return listed.length > needs.length && needs.every((each) => each === base) ? "commits" : "files";
}

/**
 * Makes a new conversation's checkout over a base's, which holds the project's default branch with its setup done: only
 * the commits the base lacks go up, none when the conversation starts at the base's own commit. What the base's setup
 * installed in files Git ignores stays. A base made without its history takes the commit's files instead when its own
 * commit cannot carry the commits up.
 */
export async function seedOverBase(location: WorkspaceLocation, start: { source: string; commit: string; branch: string; base: string; shallow?: boolean; origin?: string }): Promise<MirrorState> {
  const { install, refPrefix, repo } = location;
  const args = ["--repo", repo, "--branch", start.branch, "--commit", start.commit, ...(start.origin ? ["--origin", start.origin] : [])];
  const how = await overBase(start.source, start.commit, start.base, start.shallow === true);
  if (how !== "nothing") {
    const ref = `${refPrefix}start`;
    await pinObject(start.source, ref, start.commit);
    await inTemp(async (dir) => {
      if (how === "files") return void args.push("--pack", await send(install, await tipPack(start.source, start.commit, dir), "seed.pack"));
      const bundle = path.join(dir, "seed.bundle");
      await git(start.source, ["bundle", "create", "-q", bundle, ref, ...(how === "commits" ? [`^${start.base}`] : [])]);
      args.push("--bundle", await send(install, bundle, "seed.bundle"), "--ref", ref);
    });
  }
  await runRunner(install, "seed-over", args);
  const tree = (await git(start.source, ["rev-parse", `${start.commit}^{tree}`])).stdout.trim();
  return { snapshot: null, tree, head: start.commit, known: [start.commit] };
}

/** What a base's sandbox holds, as written when the base was made: a sandbox made from it reads it to know. */
export interface BaseMarker {
  /** The default branch's commit its checkout holds, with the project's setup done there. */
  commit: string;
  branch: string;
  /** The setup script it ran, by hash; empty for none. */
  setup: string;
  /** Each agent CLI installed, by version. */
  agents: Partial<Record<HarnessId, string>>;
  /** Seeded with its commit alone, its history still coming or lost on the way. */
  shallow?: boolean;
}

const baseMarkerPath = (install: RunnerInstall) => path.posix.join(install.state, "base.json");

export async function writeBaseMarker(install: RunnerInstall, marker: BaseMarker): Promise<void> {
  await install.sandbox.writeFile(baseMarkerPath(install), Buffer.from(JSON.stringify(marker)));
}

/** The marker of the base this sandbox was made from; null for one made empty. */
export async function readBaseMarker(install: RunnerInstall): Promise<BaseMarker | null> {
  const bytes = await install.sandbox.readFile(baseMarkerPath(install)).catch(() => null);
  if (!bytes?.length) return null;
  try {
    const marker = JSON.parse(bytes.toString("utf8")) as Partial<BaseMarker>;
    return typeof marker.commit === "string" && typeof marker.branch === "string" && typeof marker.setup === "string"
      ? { commit: marker.commit, branch: marker.branch, setup: marker.setup, agents: marker.agents ?? {}, ...(marker.shallow ? { shallow: true } : {}) }
      : null;
  } catch {
    return null;
  }
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

/**
 * Sends what changed in the mirror since the last sync, such as a commit, an undo or an edit made on the Mac between
 * turns, to the sandbox. Nothing is sent when the sandbox moved on meanwhile; the next pull keeps the Mac's edits aside.
 */
export async function pushWorkspace(location: WorkspaceLocation, state: MirrorState): Promise<{ state: MirrorState; pushed: boolean }> {
  const { install, mirror, refPrefix, repo } = location;
  const head = (await git(mirror, ["rev-parse", "HEAD"])).stdout.trim();
  const tree = await treeHash(mirror);
  if (tree === state.tree && head === state.head) return { state, pushed: false };
  const work = (await git(mirror, ["commit-tree", tree, "-p", head, "-m", "OpenOrc work from the Mac"], { env: WORK_IDENTITY })).stdout.trim();
  const ref = `${refPrefix}push`;
  await pinObject(mirror, ref, work);
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-push-"));
  let applied: boolean;
  try {
    const bundle = path.join(dir, "push.bundle");
    await git(mirror, ["bundle", "create", "-q", bundle, ref, ...state.known.map((sha) => `^${sha}`)]);
    const remoteBundle = path.posix.join(install.state, "push.bundle");
    await install.sandbox.writeFile(remoteBundle, await readFile(bundle));
    ({ applied } = await runRunner<{ applied: boolean }>(install, "apply", ["--repo", repo, "--bundle", remoteBundle, "--ref", ref, "--expect-tree", state.tree]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return applied ? { state: { snapshot: state.snapshot, tree, head, known: [work] }, pushed: true } : { state, pushed: false };
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
    state: { snapshot: result.snapshot, tree: result.tree, head: result.head, known: [result.snapshot] },
    changed: moved || current !== result.tree,
    head: result.head,
    branch: result.branch,
    keptLocalEdits,
    keptLocalCommit,
  };
}
