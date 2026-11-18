import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projects, settings, type Db } from "@openorc/db";
import { git, pinObject, treeHash, worktree as worktrees } from "@openorc/git";
import type { MirrorSnapshot } from "@openorc/protocol";
import type { Logger } from "../transport.js";

/* The read-only copies of a cloud brain's threads the person's own cloud left on this Mac, opened now only to remove them (own-cloud-cleanup.ts). */

const MIRRORS = "brain.mirrors";
/** The size one bundle may have as it travelled, base64 inside a single 16 MB message. */
const MAX_BUNDLE_BYTES = 11 * 1024 * 1024;
const IDENTITY = { GIT_AUTHOR_NAME: "OpenOrc", GIT_AUTHOR_EMAIL: "cloud@openorc.app", GIT_COMMITTER_NAME: "OpenOrc", GIT_COMMITTER_EMAIL: "cloud@openorc.app" };

const snapshotRef = (threadId: string) => `refs/openorc/mirror/${threadId}/snapshot`;
const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

/**
 * The far side of a copy: a thread's worktree as one commit (uncommitted and untracked work included) on its head,
 * pinned under a ref of the thread's own so threads in one copy never share it, and a bundle of what `known` lacks.
 */
export async function snapshotFolder(root: string, folder: string, threadId: string, known: readonly string[]): Promise<MirrorSnapshot> {
  const tree = await treeHash(folder);
  const head = (await git(folder, ["rev-parse", "-q", "--verify", "HEAD"], { okCodes: [0, 1] })).stdout.trim() || null;
  const branch = (await git(folder, ["symbolic-ref", "-q", "--short", "HEAD"], { okCodes: [0, 1] })).stdout.trim() || null;
  const snapshot = (await git(folder, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "OpenOrc mirror"], { env: IDENTITY })).stdout.trim();
  await pinObject(root, snapshotRef(threadId), snapshot);
  if (known.includes(snapshot)) return { snapshot, tree, head, branch, bundle: null };
  const have = [];
  for (const sha of known) if ((await git(root, ["cat-file", "-e", `${sha}^{commit}`], { okCodes: [0, 1, 128] })).code === 0) have.push(`^${sha}`);
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-mirror-"));
  try {
    const file = path.join(dir, "mirror.bundle");
    await git(root, ["bundle", "create", "-q", file, snapshotRef(threadId), ...have]);
    const bytes = await readFile(file);
    if (bytes.length > MAX_BUNDLE_BYTES) throw new Error("This conversation's code is too large to open on this Mac yet.");
    return { snapshot, tree, head, branch, bundle: bytes.toString("base64") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Commits this Mac's project holds that the far copy likely holds too: the thread's base and the newest branch tips.
 * The far side bundles only what lies past those it has, so a first open never carries the history both share.
 */
async function sharedTips(root: string, base: string | null): Promise<string[]> {
  const tips = (await git(root, ["for-each-ref", "--count=32", "--sort=-committerdate", "--format=%(objectname)", "refs/heads", "refs/remotes"])).stdout.split("\n").filter(Boolean);
  const hasBase = base !== null && (await git(root, ["cat-file", "-e", `${base}^{commit}`], { okCodes: [0, 1, 128] })).code === 0;
  return [...new Set([...(hasBase ? [base] : []), ...tips])].slice(0, 32);
}

interface MirrorRecord {
  projectId: string;
  path: string;
  snapshot: string;
  tree: string;
}

function records(db: Db): Record<string, MirrorRecord> {
  try {
    return JSON.parse(settings.get(db, MIRRORS) ?? "{}") as Record<string, MirrorRecord>;
  } catch {
    return {};
  }
}

/** The threads with a copy open here. */
export function openMirrors(db: Db): string[] {
  return Object.keys(records(db));
}

/** The read-only folder a thread held elsewhere has here once opened, and the Mac project it belongs to; null when closed. */
export function mirrorFolder(db: Db, threadId: string): { path: string; projectId: string } | null {
  const record = records(db)[threadId];
  return record ? { path: record.path, projectId: record.projectId } : null;
}

/**
 * Edits made in a copy stay findable under a ref of the thread's own, though they never go back. The ref, or null when
 * the copy holds the far side's files as they came.
 */
async function keepEdits(root: string, threadId: string, folder: string, record: MirrorRecord): Promise<string | null> {
  const files = await treeHash(folder);
  if (files === record.tree) return null;
  const kept = (await git(folder, ["commit-tree", files, "-p", record.snapshot, "-m", "Edits made in the copy on this Mac"], { env: IDENTITY })).stdout.trim();
  const ref = `refs/openorc/mirror/${threadId}/kept/${Date.now()}`;
  await pinObject(root, ref, kept);
  return ref;
}

/** Removes a thread's read-only copy here and its record, its edits kept aside first. False when it had none. */
export async function closeMirror(db: Db, threadId: string, log: Pick<Logger, "info">): Promise<boolean> {
  const record = records(db)[threadId];
  if (!record) return false;
  const root = projects.get(db, record.projectId)?.rootPath;
  if (root && (await exists(record.path))) {
    const kept = await keepEdits(root, threadId, record.path, record);
    if (kept) log.info(`thread ${threadId}: edits made in its copy on this Mac were kept in ${kept} when the copy closed`);
    await worktrees.remove(root, record.path, { force: true });
  }
  const all = records(db);
  delete all[threadId];
  settings.set(db, MIRRORS, JSON.stringify(all));
  return true;
}

export interface MirrorDeps {
  db: Db;
  dataDir: string;
  /** The thread's code as its holder has it now, with a bundle of what `known` lacks. */
  snapshot(threadId: string, known: string[]): Promise<MirrorSnapshot>;
  /** The thread's project where it is held, and the commit it started from. */
  thread(threadId: string): Promise<{ projectId: string; baseSha: string | null }>;
  /** The project on this Mac that stands for one held elsewhere; null when this Mac has none. */
  macProject(farProject: string): Promise<string | null>;
  changed(threadId: string): void;
  log: Logger;
}

/**
 * A thread's code mirrored into a folder of this Mac's project, read-only, one way from where the thread is held.
 * Pulls on open and whenever asked, one at a time per thread. Edits made in the copy are never sent back; the next pull
 * keeps them under a ref of the thread's own before the far side's files replace them.
 */
export class BrainMirrors {
  private readonly pulls = new Map<string, Promise<void>>();

  constructor(private readonly deps: MirrorDeps) {}

  isOpen(threadId: string): boolean {
    return records(this.deps.db)[threadId] !== undefined;
  }

  folder(threadId: string): string | null {
    return mirrorFolder(this.deps.db, threadId)?.path ?? null;
  }

  async open(threadId: string): Promise<void> {
    if (this.isOpen(threadId)) return this.pull(threadId);
    const { projectId: farProject, baseSha } = await this.deps.thread(threadId);
    const macProject = await this.deps.macProject(farProject);
    const project = macProject ? projects.get(this.deps.db, macProject) : null;
    if (!project) throw new Error("This conversation's project is not on this Mac.");
    const folder = path.join(this.deps.dataDir, "mirrors", threadId);
    const snap = await this.deps.snapshot(threadId, await sharedTips(project.rootPath, baseSha));
    await this.apply(project.rootPath, threadId, folder, snap, null);
    this.save(threadId, { projectId: project.id, path: folder, snapshot: snap.snapshot, tree: snap.tree });
  }

  /** The far side's files again; one pull per thread at a time, the next one after it. */
  pull(threadId: string): Promise<void> {
    const previous = this.pulls.get(threadId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.pullOnce(threadId))
      .catch((error: unknown) => this.deps.log.warn(`thread ${threadId}'s copy on this Mac did not refresh: ${error instanceof Error ? error.message : String(error)}`));
    this.pulls.set(threadId, next);
    return next;
  }

  async close(threadId: string): Promise<void> {
    if (await closeMirror(this.deps.db, threadId, this.deps.log)) this.deps.changed(threadId);
  }

  /** Every copy here. */
  async closeAll(): Promise<void> {
    for (const threadId of openMirrors(this.deps.db))
      await this.close(threadId).catch((error: unknown) => this.deps.log.warn(`thread ${threadId}'s copy on this Mac was not removed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async pullOnce(threadId: string): Promise<void> {
    const record = records(this.deps.db)[threadId];
    const root = record && projects.get(this.deps.db, record.projectId)?.rootPath;
    if (!record || !root) return;
    const snap = await this.deps.snapshot(threadId, [record.snapshot]);
    // Closed while the far side answered: nothing is left to refresh.
    if (snap.snapshot === record.snapshot || !this.isOpen(threadId)) return;
    await this.apply(root, threadId, record.path, snap, record);
    this.save(threadId, { ...record, snapshot: snap.snapshot, tree: snap.tree });
  }

  private async apply(root: string, threadId: string, folder: string, snap: MirrorSnapshot, record: MirrorRecord | null): Promise<void> {
    if (snap.bundle) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-mirror-"));
      try {
        const file = path.join(dir, "mirror.bundle");
        await writeFile(file, Buffer.from(snap.bundle, "base64"));
        await git(root, ["fetch", "--no-tags", "--no-write-fetch-head", "-q", file, `+${snapshotRef(threadId)}:${snapshotRef(threadId)}`]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    if (!(await exists(folder))) {
      await mkdir(path.dirname(folder), { recursive: true });
      await git(root, ["worktree", "add", "--detach", "-q", folder, snap.snapshot]);
      return;
    }
    if (record) await keepEdits(root, threadId, folder, record);
    await git(folder, ["checkout", "-q", "--detach", "-f", snap.snapshot]);
    await git(folder, ["clean", "-q", "-fd"]);
  }

  private save(threadId: string, record: MirrorRecord): void {
    settings.set(this.deps.db, MIRRORS, JSON.stringify({ ...records(this.deps.db), [threadId]: record }));
    this.deps.changed(threadId);
  }
}
