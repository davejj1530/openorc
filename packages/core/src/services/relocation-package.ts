import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { ThreadRows } from "@openorc/db";
import { git, pinObject, switchFiles, treeHash, worktree as worktrees } from "@openorc/git";
import { SESSION_ID, type Brain, type Thread } from "@openorc/protocol";
import { z } from "zod";
import type { RelocatedSession } from "./cloud-sessions.js";
import { checkpointRefs, snapshotRefs } from "./checkpoint-refs.js";

/**
 * Everything a thread needs to continue on the other brain: its rows, the files they name, its agent's session, and its
 * code as one git bundle of its branch, its uncommitted work and its checkpoints. The same format both ways.
 */
export interface RelocationPackage {
  v: 1;
  relocation: string;
  from: Brain;
  /** The Mac project the thread belongs to, whichever brain packs it. */
  macProject: string;
  rows: ThreadRows;
  /** The source's data folder and the thread's worktree there, which the target replaces with its own. */
  dataDir: string;
  worktree: string;
  /** Attachments and tool images the rows name, by their path under the data folder. */
  files: { path: string; bytes: Buffer }[];
  session: RelocatedSession | null;
  code: {
    branch: string;
    head: string;
    /** The working tree as a commit on top of head, uncommitted and untracked work included; null when clean. */
    work: string | null;
    /** The thread's checkpoint refs and its tasks' snapshot refs. */
    checkpoints: string[];
    /** The branch, the work and the checkpoint refs, minus what the target is known to have. */
    bundle: Buffer;
  };
}

/** The target could not take the package and committed nothing, in words a person can read. */
export class RelocationRefused extends Error {}

/** The bundle builds on a commit the target lacks; a whole one will do. */
export class LacksBase extends RelocationRefused {
  constructor() {
    super("The other side lacks the commit this thread's code builds on.");
  }
}

const MAGIC = Buffer.from("OPENORC-THREAD-1\n");
const MAX_BYTES = 2 ** 31;
const FILE_PATH = /^(attachments\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}|tool-images\/[A-Za-z0-9-]{1,100}\/[A-Za-z0-9][A-Za-z0-9._-]{0,254})$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const ID = z.string().min(1).max(200);

const Header = z
  .object({
    v: z.literal(1),
    relocation: ID,
    from: z.enum(["mac", "cloud"]),
    macProject: ID,
    rows: z.object({ v: z.literal(1), threadId: ID, tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))), search: z.array(z.record(z.string(), z.unknown())) }),
    dataDir: z.string().min(1).max(4096),
    worktree: z.string().min(1).max(4096),
    // How many tasks travel: a brain from before tasks moved refuses this unknown field rather than drop them.
    tasks: z.number().int().positive().optional(),
    files: z.array(z.object({ path: z.string().regex(FILE_PATH), size: z.number().int().nonnegative() })).max(100_000),
    session: z.object({ agent: z.literal("claude"), accountId: ID, sessionId: z.string().regex(SESSION_ID), text: z.string() }).nullable(),
    code: z.object({
      branch: z
        .string()
        .regex(/^\w[\w./+-]*$/)
        .max(255),
      head: z.string().regex(COMMIT),
      work: z.string().regex(COMMIT).nullable(),
      checkpoints: z.array(z.string().regex(/^refs\/openorc\/(checkpoints|snapshots)\/[A-Za-z0-9-]+\/[A-Za-z0-9._/-]+$/)).max(100_000),
      size: z.number().int().positive(),
    }),
  })
  .strict();

export function encodePackage(pkg: RelocationPackage): Buffer {
  const { files, code, ...rest } = pkg;
  const tasks = pkg.rows.tables.tasks?.length;
  const header = {
    ...rest,
    ...(tasks ? { tasks } : {}),
    files: files.map((file) => ({ path: file.path, size: file.bytes.length })),
    code: { ...code, bundle: undefined, size: code.bundle.length },
  };
  const json = gzipSync(Buffer.from(JSON.stringify(header)));
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(json.length));
  return Buffer.concat([MAGIC, length, json, ...files.map((file) => file.bytes), code.bundle]);
}

/** Checks a package at the boundary: its format, sizes and every name it would write. Throws RelocationRefused. */
export function decodePackage(bytes: Buffer): RelocationPackage {
  const refuse = (why: string): never => {
    throw new RelocationRefused(`The thread's package is not valid: ${why}.`);
  };
  if (bytes.length > MAX_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) refuse("it is not a thread package");
  const start = MAGIC.length + 8;
  const length = Number(bytes.readBigUInt64BE(MAGIC.length));
  if (start + length > bytes.length) refuse("it is cut short");
  let parsed: z.infer<typeof Header>;
  try {
    parsed = Header.parse(JSON.parse(gunzipSync(bytes.subarray(start, start + length)).toString("utf8")));
  } catch {
    return refuse("its header does not read");
  }
  let offset = start + length;
  const take = (size: number) => {
    const slice = bytes.subarray(offset, offset + size);
    offset += size;
    return Buffer.from(slice);
  };
  const files = parsed.files.map((file) => ({ path: file.path, bytes: take(file.size) }));
  const bundle = take(parsed.code.size);
  if (offset !== bytes.length) refuse("its sizes do not add up");
  if ((parsed.tasks ?? 0) !== (parsed.rows.tables["tasks"]?.length ?? 0)) refuse("its tasks do not add up");
  // A run's session id names the session's file here once the thread resumes, so it is a plain name or nothing.
  if ((parsed.rows.tables["runs"] ?? []).some(({ external_session_id: id }) => id != null && !(typeof id === "string" && SESSION_ID.test(id))))
    refuse("a run names a session that is not a plain name");
  const { size: _size, ...code } = parsed.code;
  const { tasks: _tasks, ...header } = parsed;
  return { ...header, rows: parsed.rows as ThreadRows, files, code: { ...code, bundle } };
}

/** The data folder's files the rows name: attachments by path or asset URL, and every tool image of their runs. */
async function namedFiles(dataDir: string, rows: ThreadRows): Promise<{ path: string; bytes: Buffer }[]> {
  const text = JSON.stringify(rows);
  const names = new Set<string>();
  const attachments = `${path.join(dataDir, "attachments")}/`;
  for (const prefix of [attachments, "openorc-asset://attachments/"])
    for (let at = text.indexOf(prefix); at >= 0; at = text.indexOf(prefix, at + 1)) {
      const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(text.slice(at + prefix.length))?.[0];
      if (name) names.add(`attachments/${name}`);
    }
  for (const run of rows.tables.runs) {
    const folder = path.join("tool-images", String(run.id));
    for (const name of await readdir(path.join(dataDir, folder)).catch(() => [] as string[])) names.add(`${folder}/${name}`);
  }
  const files: { path: string; bytes: Buffer }[] = [];
  for (const name of [...names].filter((each) => FILE_PATH.test(each))) {
    const bytes = await readFile(path.join(dataDir, name)).catch(() => null);
    if (bytes) files.push({ path: name, bytes });
  }
  return files;
}

const WORK_IDENTITY = { GIT_AUTHOR_NAME: "OpenOrc", GIT_AUTHOR_EMAIL: "cloud@openorc.app", GIT_COMMITTER_NAME: "OpenOrc", GIT_COMMITTER_EMAIL: "cloud@openorc.app" };
const workRef = (threadId: string) => `refs/openorc/relocate/${threadId}/work`;
const incoming = (threadId: string) => `refs/openorc/incoming/${threadId}/`;

async function commitKnown(root: string, commit: string): Promise<boolean> {
  return (await git(root, ["cat-file", "-e", `${commit}^{commit}`], { okCodes: [0, 1, 128] })).code === 0;
}

/**
 * The worktree's branch, uncommitted work, checkpoints and its tasks' snapshots as one bundle, without the commits `since`
 * already holds.
 */
async function packCode(root: string, thread: Thread & { worktreePath: string; branch: string }, tasks: readonly string[], since: readonly string[]): Promise<RelocationPackage["code"]> {
  const tree = thread.worktreePath;
  const head = (await git(tree, ["rev-parse", "HEAD"])).stdout.trim();
  const files = await treeHash(tree);
  const work =
    files === (await git(tree, ["rev-parse", `${head}^{tree}`])).stdout.trim()
      ? null
      : (await git(tree, ["commit-tree", files, "-p", head, "-m", "OpenOrc work in progress"], { env: WORK_IDENTITY })).stdout.trim();
  if (work) await pinObject(root, workRef(thread.id), work);
  const listed = (await git(root, ["for-each-ref", "--format=%(refname)", checkpointRefs(thread.id), ...tasks.map(snapshotRefs)])).stdout.split("\n").filter(Boolean);
  const exclude = [];
  for (const commit of since) if (commit !== head && (await commitKnown(root, commit))) exclude.push(`^${commit}`);
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-relocate-"));
  try {
    const file = path.join(dir, "thread.bundle");
    await git(root, ["bundle", "create", "-q", file, `refs/heads/${thread.branch}`, ...(work ? [workRef(thread.id)] : []), ...listed, ...exclude]);
    return { branch: thread.branch, head, work, checkpoints: listed, bundle: await readFile(file) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface PackInput {
  relocation: string;
  from: Brain;
  macProject: string;
  dataDir: string;
  /** The project repository the thread's worktree belongs to. */
  root: string;
  /** Read in one transaction after the ledger's last events are written. */
  rows: () => ThreadRows;
  thread: Thread;
  /** The tasks that move with it, whose snapshots go in the bundle. */
  tasks: readonly string[];
  session: RelocatedSession | null;
  /** Commits the target is known to have. */
  since: readonly string[];
}

export async function packThread(input: PackInput): Promise<RelocationPackage> {
  const { thread } = input;
  if (!thread.worktreePath || !thread.branch) throw new RelocationRefused("Only a conversation on a branch of its own can move.");
  const code = await packCode(input.root, { ...thread, worktreePath: thread.worktreePath, branch: thread.branch }, input.tasks, input.since);
  const rows = input.rows();
  return {
    v: 1,
    relocation: input.relocation,
    from: input.from,
    macProject: input.macProject,
    rows,
    dataDir: input.dataDir,
    worktree: thread.worktreePath,
    files: await namedFiles(input.dataDir, rows),
    session: input.session,
    code,
  };
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

/**
 * The target's side of the code: the bundle's objects under incoming refs, the branch moved to the thread's head (a tip
 * it would lose kept under refs/openorc/kept), a worktree on it at `folder`, and the uncommitted work left uncommitted.
 * Safe to repeat: a worktree an earlier attempt made is reset and filled again.
 */
export async function takeCode(root: string, threadId: string, code: RelocationPackage["code"], folder: string): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-relocate-"));
  try {
    const file = path.join(dir, "thread.bundle");
    await writeFile(file, code.bundle);
    if ((await git(root, ["bundle", "verify", "-q", file], { okCodes: [0, 1, 128] })).code !== 0) throw new LacksBase();
    const refs = [
      `+refs/heads/${code.branch}:${incoming(threadId)}head`,
      ...(code.work ? [`+${workRef(threadId)}:${incoming(threadId)}work`] : []),
      ...code.checkpoints.map((ref) => `+${ref}:${ref}`),
    ];
    await git(root, ["fetch", "--no-tags", "--no-write-fetch-head", "-q", file, ...refs]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await assertBranchFree(root, code.branch, folder);
  if (await exists(folder)) {
    await git(folder, ["checkout", "-q", "-B", code.branch, code.head]);
    await git(folder, ["reset", "-q", "--hard", code.head]);
    await git(folder, ["clean", "-q", "-fd"]);
  } else {
    const tip = (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${code.branch}`], { okCodes: [0, 1] })).stdout.trim();
    if (tip && tip !== code.head) {
      const kept = (await git(root, ["merge-base", "--is-ancestor", tip, code.head], { okCodes: [0, 1] })).code !== 0;
      if (kept) await pinObject(root, `refs/openorc/kept/${threadId}/${Date.now()}`, tip);
      await git(root, ["branch", "-f", code.branch, code.head]);
    }
    await mkdir(path.dirname(folder), { recursive: true });
    await worktrees.add(root, { path: folder, branch: code.branch, startPoint: code.head });
  }
  if (code.work) await switchFiles(folder, `${code.head}^{tree}`, `${code.work}^{tree}`);
}

/** Git moves no branch another folder has checked out, so a thread whose branch is open elsewhere cannot come here. */
async function assertBranchFree(root: string, branch: string, folder: string): Promise<void> {
  await git(root, ["worktree", "prune"]);
  const here = await realpath(folder).catch(() => path.resolve(folder));
  for (const entry of await worktrees.list(root))
    if (entry.branch === branch && (await realpath(entry.path).catch(() => entry.path)) !== here)
      throw new RelocationRefused("Its branch is checked out in another folder. Switch that folder to another branch, then try again.");
}

/** The package's files under this host's data folder; a file already there is left as it is. */
export async function takeFiles(dataDir: string, files: RelocationPackage["files"]): Promise<void> {
  for (const file of files) {
    const target = path.join(dataDir, file.path);
    if (await exists(target)) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
}

/**
 * The source's worktree once the target holds the thread: its last state pinned under refs/openorc/relocated/<id>, so
 * nothing in it is lost, then the worktree removed. The branch stays. Safe to repeat.
 */
export async function retireCode(root: string, threadId: string, folder: string | null): Promise<void> {
  if (folder && (await exists(folder))) {
    const head = (await git(folder, ["rev-parse", "HEAD"])).stdout.trim();
    const files = await treeHash(folder);
    const changed = files !== (await git(folder, ["rev-parse", `${head}^{tree}`])).stdout.trim();
    const last = changed ? (await git(folder, ["commit-tree", files, "-p", head, "-m", "OpenOrc work when the conversation moved"], { env: WORK_IDENTITY })).stdout.trim() : head;
    await pinObject(root, `refs/openorc/relocated/${threadId}`, last);
    await worktrees.remove(root, folder, { force: true });
  }
  await worktrees.prune(root).catch(() => undefined);
}
