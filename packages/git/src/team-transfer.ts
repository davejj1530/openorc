import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commandExitCode, GitError } from "./exec.js";
import type { BigIntStats } from "node:fs";

export interface TeamTreeEntry {
  path: string;
  mode: "100644" | "100755" | "120000";
  oid: string;
}
export interface TeamTreeSnapshot {
  rootPath: string;
  headSha: string;
  branch: string | null;
  treeSha: string;
  treeRef: string;
  headRef: string;
  indexSha256: string | null;
}
export type TeamMergeResult =
  | { status: "clean"; treeSha: string; treeRef: string; worktreePath: string; indexPath: string; retainedRefs: string[] }
  | { status: "conflict"; conflicts: string[]; worktreePath: string; indexPath: string; retainedRefs: string[] };

// Git's usual text helper is intentionally not used: blob bytes and NUL-delimited
// paths must survive unchanged. No user clean/smudge or custom merge driver runs.
async function command(cwd: string, args: string[], options: { input?: Buffer; index?: string; okCodes?: number[] } = {}) {
  return new Promise<{ stdout: Buffer; stderr: Buffer; code: number }>((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        encoding: "buffer",
        timeout: 60_000,
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_INDEX_FILE: options.index },
      },
      (error, stdout, stderr) => {
        const code = commandExitCode(error);
        if (code === null || !(options.okCodes ?? [0]).includes(code)) reject(new GitError(args, cwd, code, stderr.toString("utf8")));
        else resolve({ stdout, stderr, code });
      },
    );
    child.stdin?.on("error", () => {}); // The command callback reports early exits.
    child.stdin?.end(options.input);
  });
}
const text = (buffer: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(buffer);
const output = async (cwd: string, args: string[]) => text((await command(cwd, args)).stdout).replace(/\n$/, "");
function objectId(value: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error("Team transfer requires a resolved Git object ID.");
}
function safePath(value: string): void {
  if (!value || value.includes("\0") || path.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git"))
    throw new Error(`Unsupported Git tree path: ${JSON.stringify(value)}.`);
}
function parseEntry(value: string): TeamTreeEntry {
  const tab = value.indexOf("\t");
  const [mode, type, oid] = value.slice(0, tab).split(" ");
  const name = value.slice(tab + 1);
  if (tab < 0 || type !== "blob" || !["100644", "100755", "120000"].includes(mode ?? "") || !oid)
    throw new Error(`Unsupported Git tree entry (submodules and special files cannot be transferred): ${JSON.stringify(name)}.`);
  safePath(name);
  objectId(oid);
  return { path: name, mode: mode as TeamTreeEntry["mode"], oid };
}

export async function listTree(cwd: string, treeSha: string): Promise<TeamTreeEntry[]> {
  objectId(treeSha);
  const entries = text((await command(cwd, ["ls-tree", "-r", "-z", treeSha])).stdout)
    .split("\0")
    .filter(Boolean)
    .map(parseEntry);
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.path)) throw new Error(`Duplicate Git tree path: ${JSON.stringify(entry.path)}.`);
    names.add(entry.path);
  }
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join("/"))) throw new Error(`Conflicting Git tree path: ${JSON.stringify(entry.path)}.`);
  }
  return entries;
}

export interface TreeDeltaEntry {
  path: string;
  before: TeamTreeEntry | null;
  after: TeamTreeEntry | null;
}

/**
 * The files that differ between two trees, with each side's mode and blob. A submodule pointer names another
 * repository's commit, not bytes that can be written here: it is skipped, or refused when `submodules` says so.
 */
export async function treeDelta(cwd: string, fromTree: string, toTree: string, options: { submodules?: "skip" | "refuse" } = {}): Promise<TreeDeltaEntry[]> {
  objectId(fromTree);
  objectId(toTree);
  const fields = text((await command(cwd, ["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-ext-diff", fromTree, toTree])).stdout).split("\0");
  const entries: TreeDeltaEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode, oldOid, newOid] = fields[i]!.replace(/^:/, "").split(" ");
    const name = fields[i + 1]!;
    if (oldMode === "160000" || newMode === "160000") {
      if (options.submodules === "refuse") throw new Error(`The submodule or nested repository at ${JSON.stringify(name)} changed. Commit or undo that change first.`);
      continue;
    }
    const side = (mode: string | undefined, oid: string | undefined) => (mode && oid && !/^0+$/.test(mode) ? parseEntry(`${mode} blob ${oid}\t${name}`) : null);
    entries.push({ path: name, before: side(oldMode, oldOid), after: side(newMode, newOid) });
  }
  return entries;
}

/** `baseTree` with each entry's path set to its `after` side, or removed where there is none. */
export async function overlayTree(cwd: string, baseTree: string, entries: readonly TreeDeltaEntry[]): Promise<string> {
  objectId(baseTree);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "openorc-overlay-"));
  const index = path.join(temporary, "index");
  try {
    await command(cwd, ["read-tree", baseTree], { index });
    const zero = "0".repeat(baseTree.length);
    const lines = entries.map((entry) => (entry.after ? `${entry.after.mode} ${entry.after.oid}\t${entry.path}\0` : `0 ${zero}\t${entry.path}\0`));
    if (lines.length) await command(cwd, ["update-index", "-z", "--index-info"], { index, input: Buffer.from(lines.join("")) });
    return text((await command(cwd, ["write-tree"], { index })).stdout).trim();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function readBlob(cwd: string, oid: string): Promise<Buffer> {
  objectId(oid);
  return (await command(cwd, ["cat-file", "blob", oid])).stdout;
}

async function retainObject(cwd: string, oid: string, ref: string): Promise<void> {
  objectId(oid);
  if (!ref.startsWith("refs/openorc/")) throw new Error("Team snapshots must use refs/openorc/ retention refs.");
  await command(cwd, ["check-ref-format", ref]);
  const existing = await command(cwd, ["show-ref", "--verify", "--hash", ref], { okCodes: [0, 1, 128] });
  if (existing.code === 0) {
    if (text(existing.stdout).trim() !== oid) throw new Error(`Team snapshot ref ${ref} already retains a different object.`);
    return;
  }
  await command(cwd, ["update-ref", ref, oid, "0".repeat(oid.length)]);
}

/** Pin a tree object directly; retention does not create a commit or move HEAD. */
export async function retainTree(cwd: string, treeSha: string, ref: string): Promise<void> {
  await listTree(cwd, treeSha);
  if ((await output(cwd, ["cat-file", "-t", treeSha])) !== "tree") throw new Error("A team snapshot must retain a tree object.");
  await retainObject(cwd, treeSha, ref);
}

/**
 * What the index says about content: modes, object ids, stages and paths. A
 * provider running `git status` rewrites the index file's stat cache without
 * changing any of this, so the capture guard compares content, not bytes.
 */
export async function indexContentDigest(cwd: string): Promise<string | null> {
  const file = path.resolve(cwd, await output(cwd, ["rev-parse", "--git-path", "index"]));
  if (!(await fileState(file))) return null;
  return createHash("sha256")
    .update((await command(cwd, ["ls-files", "--stage", "-z"])).stdout)
    .digest("hex");
}
const indexDigest = indexContentDigest;
async function head(cwd: string) {
  const sha = await output(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const symbolic = await command(cwd, ["symbolic-ref", "--quiet", "HEAD"], { okCodes: [0, 1] });
  return { sha, branch: symbolic.code === 0 ? text(symbolic.stdout).trim() : null };
}
async function pathsFor(cwd: string, trackedTrees: string[]): Promise<string[]> {
  const inherited = (await Promise.all(trackedTrees.map((tree) => listTree(cwd, tree)))).flatMap((entries) => entries.map((entry) => entry.path));
  const indexed = text((await command(cwd, ["ls-files", "--stage", "-z"])).stdout)
    .split("\0")
    .filter(Boolean);
  for (const entry of indexed) if (entry.startsWith("160000 ")) throw new Error("A snapshot cannot include submodules.");
  const tracked = indexed.map((entry) => entry.slice(entry.indexOf("\t") + 1));
  // ls-files silently omits FIFO/socket/device entries. Walk nonignored paths
  // ourselves so an unsupported entry causes an explicit failure, not data loss.
  const untracked: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const children = await readdir(path.join(cwd, relative), { withFileTypes: true, encoding: "buffer" });
    const candidates = children.map((entry) => ({ entry, name: path.posix.join(relative, text(entry.name)) })).filter(({ name }) => name !== ".git");
    if (!candidates.length) return;
    const ignored = new Set(
      text((await command(cwd, ["check-ignore", "--no-index", "-z", "--stdin"], { input: Buffer.from(candidates.map((item) => item.name).join("\0") + "\0"), okCodes: [0, 1] })).stdout)
        .split("\0")
        .filter(Boolean),
    );
    for (const { entry, name } of candidates) {
      if (ignored.has(name)) continue;
      safePath(name);
      if (entry.isDirectory()) {
        if (await fileState(path.join(cwd, name, ".git"))) throw new Error(`Nested repositories cannot be transferred: ${JSON.stringify(name)}.`);
        await walk(name);
      } else if (entry.isFile() || entry.isSymbolicLink()) untracked.push(name);
      else throw new Error(`A snapshot cannot include special files such as sockets or devices: ${JSON.stringify(name)}.`);
    }
  };
  await walk("");
  const paths = [...new Set([...inherited, ...tracked, ...untracked].map((name) => name.replace(/\/$/, "")))].sort();
  for (const name of paths) safePath(name);
  return paths;
}
async function fileState(file: string) {
  try {
    const stat = await lstat(file, { bigint: true });
    return { stat, key: `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}
async function sourceState(root: string, name: string) {
  const parts = name.split("/");
  for (let i = 1; i < parts.length; i++) {
    const parent = await fileState(path.join(root, ...parts.slice(0, i)));
    // A tracked directory can become a symlink or ordinary file. Its former
    // children are deletions, not permission to follow that new path outside.
    if (!parent?.stat.isDirectory()) return null;
  }
  return fileState(path.join(root, name));
}
async function writeIndex(cwd: string, index: string, entries: TeamTreeEntry[]): Promise<void> {
  await command(cwd, ["read-tree", "--empty"], { index });
  if (entries.length) await command(cwd, ["update-index", "-z", "--index-info"], { index, input: Buffer.from(entries.map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}\0`).join("")) });
}

/** Hash current file bytes without filters; record the exact filesystem signatures checked after the tree is written. */
async function hashWorkingEntries(rootPath: string, names: readonly string[]): Promise<{ entries: TeamTreeEntry[]; observed: Map<string, string | null> }> {
  const entries: TeamTreeEntry[] = [];
  const observed = new Map<string, string | null>();
  // Regular files are hashed by one Git process; symlinks store their target bytes individually.
  const regular: { name: string; mode: TeamTreeEntry["mode"] }[] = [];
  for (const name of names) {
    const file = path.join(rootPath, name);
    const state = await sourceState(rootPath, name);
    observed.set(name, state?.key ?? null);
    if (!state) continue;
    if (state.stat.isDirectory()) {
      if (await fileState(path.join(file, ".git"))) throw new Error(`Nested repositories cannot be transferred: ${JSON.stringify(name)}.`);
      continue; // A tracked file may have become a directory; its children are untracked paths.
    }
    if (!state.stat.isFile() && !state.stat.isSymbolicLink()) throw new Error(`A snapshot cannot include special files such as sockets or devices: ${JSON.stringify(name)}.`);
    const mode = workingEntryMode(state.stat);
    // Symlinks store their target bytes; a name with a line break cannot travel through the batched path list.
    if (state.stat.isSymbolicLink() || /[\r\n]/.test(name)) {
      const oid = text(
        (await command(rootPath, ["hash-object", "-w", "--no-filters", "--stdin"], { input: state.stat.isSymbolicLink() ? await readlink(file, { encoding: "buffer" }) : await readFile(file) }))
          .stdout,
      ).trim();
      entries.push({ path: name, mode, oid });
    } else regular.push({ name, mode });
  }
  for (let start = 0; start < regular.length; start += 500) {
    const batch = regular.slice(start, start + 500);
    const hashed = text((await command(rootPath, ["hash-object", "-w", "--no-filters", "--stdin-paths"], { input: Buffer.from(batch.map((item) => item.name + "\n").join("")) })).stdout)
      .split("\n")
      .filter(Boolean);
    if (hashed.length !== batch.length) throw new Error("Git hashed a different number of files than the team snapshot listed.");
    batch.forEach((item, index) => {
      objectId(hashed[index]!);
      entries.push({ path: item.name, mode: item.mode, oid: hashed[index]! });
    });
  }
  entries.sort(compareEntryPaths);
  return { entries, observed };
}

/** A retained tree is only valid if HEAD, index contents, path set and each observed file still match. */
async function assertCaptureSource(input: {
  rootPath: string;
  before: Awaited<ReturnType<typeof head>>;
  indexSha256: string | null;
  names: string[];
  observed: ReadonlyMap<string, string | null>;
  capturePaths: () => Promise<string[]>;
}): Promise<void> {
  const { rootPath, before, indexSha256, names, observed, capturePaths } = input;
  const after = await head(rootPath);
  if (before.sha !== after.sha || before.branch !== after.branch || indexSha256 !== (await indexDigest(rootPath)) || JSON.stringify(names) !== JSON.stringify(await capturePaths()))
    throw new Error("The source changed while its team snapshot was captured. Retry under the workspace writer lease.");
  for (const [name, signature] of observed)
    if ((await sourceState(rootPath, name))?.key !== (signature ?? undefined)) throw new Error("A source file changed while its team snapshot was captured. Retry under the workspace writer lease.");
}

/**
 * Capture working bytes, including nonignored untracked files, without changing
 * the real index. Tracked trees preserve inherited input even after ignore edits;
 * multiple trees contribute paths, while current filesystem bytes always win.
 * Callers must hold their workspace writer lease; changes detected during capture
 * fail instead of returning a mixed snapshot.
 */
export async function capture(
  cwd: string,
  options: {
    refPrefix: string;
    trackedTree?: string;
    additionalTrackedTrees?: string[];
    /** Explicit local setup inputs, captured separately from tracked source lineage. */
    paths?: readonly string[];
  },
): Promise<TeamTreeSnapshot> {
  const rootPath = await realpath(await output(cwd, ["rev-parse", "--show-toplevel"]));
  const before = await head(rootPath);
  const indexSha256 = await indexDigest(rootPath);
  const trackedTrees = [...new Set([options.trackedTree ?? (await output(rootPath, ["rev-parse", "HEAD^{tree}"])), ...(options.additionalTrackedTrees ?? [])])];
  const capturePaths = async () => {
    if (options.paths === undefined) return pathsFor(rootPath, trackedTrees);
    const names = [...new Set(options.paths)].sort();
    names.forEach(safePath);
    return names;
  };
  const names = await capturePaths();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "openorc-team-capture-"));
  try {
    const { entries, observed } = await hashWorkingEntries(rootPath, names);
    const index = path.join(temporary, "index");
    await writeIndex(rootPath, index, entries);
    const treeSha = text((await command(rootPath, ["write-tree"], { index })).stdout).trim();
    await assertCaptureSource({ rootPath, before, indexSha256, names, observed, capturePaths });
    const treeRef = `${options.refPrefix}/tree`;
    const headRef = `${options.refPrefix}/head`;
    await retainTree(rootPath, treeSha, treeRef);
    await retainObject(rootPath, before.sha, headRef);
    return { rootPath, headSha: before.sha, branch: before.branch, treeSha, treeRef, headRef, indexSha256 };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Raw blob bytes for many objects from one `cat-file --batch` process, in the order requested. */
async function readBlobs(cwd: string, oids: readonly string[]): Promise<Buffer[]> {
  oids.forEach(objectId);
  if (!oids.length) return [];
  const out = (await command(cwd, ["cat-file", "--batch"], { input: Buffer.from(oids.map((oid) => oid + "\n").join("")) })).stdout;
  const blobs: Buffer[] = [];
  let offset = 0;
  for (const oid of oids) {
    const newline = out.indexOf(0x0a, offset);
    const header = out.subarray(offset, newline).toString("utf8").split(" ");
    if (header[0] !== oid || header[1] !== "blob") throw new Error(`Git returned ${header.join(" ")} instead of blob ${oid}.`);
    const size = Number(header[2]);
    blobs.push(out.subarray(newline + 1, newline + 1 + size));
    offset = newline + 1 + size + 1;
  }
  return blobs;
}

const writeEntry = (cwd: string, root: string, entry: TeamTreeEntry) => writeEntries(cwd, root, [entry]);
async function writeEntries(cwd: string, root: string, entries: readonly TeamTreeEntry[]): Promise<void> {
  for (const entry of entries) safePath(entry.path);
  for (let start = 0; start < entries.length; start += 256) {
    const batch = entries.slice(start, start + 256);
    const blobs = await readBlobs(
      cwd,
      batch.map((entry) => entry.oid),
    );
    for (const [index, entry] of batch.entries()) {
      const file = path.join(root, entry.path);
      await mkdir(path.dirname(file), { recursive: true });
      if (entry.mode === "120000") await symlink(blobs[index]!, file);
      else {
        await writeFile(file, blobs[index]!);
        await chmod(file, entry.mode === "100755" ? 0o755 : 0o644);
      }
    }
  }
}
async function createWorktree(cwd: string, target: string, headSha: string, treeSha: string): Promise<void> {
  objectId(headSha);
  if (!path.isAbsolute(target)) throw new Error("Team worktree destination must be an absolute path.");
  const entries = await listTree(cwd, treeSha);
  if (await fileState(target)) throw new Error("Team worktree destination must not already exist.");
  await mkdir(path.dirname(target), { recursive: true });
  await command(cwd, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", "--no-checkout", target, headSha]);
  // This is the new worktree's own index, never the source index.
  await command(target, ["read-tree", headSha]);
  await writeEntries(cwd, target, entries);
}

/**
 * A snapshot of one committed tree, for a team that starts from a chosen base
 * ref rather than the checkout's current files. Nothing uncommitted is included.
 */
export async function captureCommit(cwd: string, commit: string, options: { refPrefix: string }): Promise<TeamTreeSnapshot> {
  const rootPath = await realpath(await output(cwd, ["rev-parse", "--show-toplevel"]));
  const headSha = await output(rootPath, ["rev-parse", "--verify", `${commit}^{commit}`]);
  const treeSha = await output(rootPath, ["rev-parse", "--verify", `${headSha}^{tree}`]);
  const treeRef = `${options.refPrefix}/tree`,
    headRef = `${options.refPrefix}/head`;
  await retainTree(rootPath, treeSha, treeRef);
  await retainObject(rootPath, headSha, headRef);
  return { rootPath, headSha, branch: null, treeSha, treeRef, headRef, indexSha256: null };
}

/** Create a detached worktree at the captured HEAD and seed raw captured bytes. */
export async function materialize(cwd: string, options: { snapshot: TeamTreeSnapshot; path: string }): Promise<void> {
  await createWorktree(cwd, options.path, options.snapshot.headSha, options.snapshot.treeSha);
}

interface StageEntry extends TeamTreeEntry {
  stage: number;
}
async function indexEntries(cwd: string, index: string): Promise<StageEntry[]> {
  return text((await command(cwd, ["ls-files", "--stage", "-z"], { index })).stdout)
    .split("\0")
    .filter(Boolean)
    .map((value) => {
      const tab = value.indexOf("\t");
      const [mode, oid, stage] = value.slice(0, tab).split(" ");
      return { ...parseEntry(`${mode} blob ${oid}\t${value.slice(tab + 1)}`), stage: Number(stage) };
    });
}

/**
 * One path that changed on both sides, merged with Git's builtin text merge when all three sides are regular files
 * and their modes can be combined. Returns the merged entry, or the conflict with its marked-up text when Git made one.
 */
async function mergeStages(
  cwd: string,
  name: string,
  stages: StageEntry[],
  scratch: string,
  labels: readonly [string, string, string],
): Promise<{ entry: TeamTreeEntry } | { conflict: Buffer | null }> {
  const base = stages.find((entry) => entry.stage === 1);
  const ours = stages.find((entry) => entry.stage === 2);
  const theirs = stages.find((entry) => entry.stage === 3);
  const regular = (entry: StageEntry | undefined): entry is StageEntry => entry !== undefined && entry.mode !== "120000";
  if (!regular(base) || !regular(ours) || !regular(theirs)) return { conflict: null };
  const mode = mergedEntryMode({ base: base.mode, ours: ours.mode, theirs: theirs.mode });
  if (!mode) return { conflict: null };
  const files = ["ours", "base", "theirs"].map((part) => path.join(scratch, part));
  for (const [position, entry] of [ours, base, theirs].entries()) await writeFile(files[position]!, await readBlob(cwd, entry.oid));
  const merged = await command(cwd, ["merge-file", "-p", "--diff3", "-L", labels[0], "-L", labels[1], "-L", labels[2], ...files], {
    okCodes: Array.from({ length: 256 }, (_, i) => i),
  });
  if (merged.code !== 0) return { conflict: merged.code < 128 && merged.stdout.length ? merged.stdout : null };
  const oid = text((await command(cwd, ["hash-object", "-w", "--no-filters", "--stdin"], { input: merged.stdout })).stdout).trim();
  return { entry: { path: name, mode, oid } };
}

/**
 * Merges the change from `base` to `theirs` into `ours` in a throwaway index, with no working tree. Returns the
 * merged tree, or the paths that changed on both sides in ways Git's builtin text merge cannot combine. Submodule
 * pointers merge only when at most one side moved them.
 */
export async function mergeTrees(cwd: string, trees: { base: string; ours: string; theirs: string }): Promise<{ tree: string } | { conflicts: string[] }> {
  for (const tree of [trees.base, trees.ours, trees.theirs]) objectId(tree);
  if (trees.base === trees.theirs || trees.ours === trees.theirs) return { tree: trees.ours };
  if (trees.base === trees.ours) return { tree: trees.theirs };
  const temporary = await mkdtemp(path.join(os.tmpdir(), "openorc-merge-"));
  const index = path.join(temporary, "index");
  try {
    await command(cwd, ["read-tree", "-m", "-i", "--aggressive", trees.base, trees.ours, trees.theirs], { index });
    const staged = text((await command(cwd, ["ls-files", "--stage", "-z"], { index })).stdout)
      .split("\0")
      .filter(Boolean)
      .map((value) => {
        const tab = value.indexOf("\t");
        const [mode, oid, stage] = value.slice(0, tab).split(" ");
        return { name: value.slice(tab + 1), mode: mode!, oid: oid!, stage: Number(stage) };
      })
      .filter((entry) => entry.stage !== 0);
    const conflicts: string[] = [];
    for (const name of new Set(staged.map((entry) => entry.name))) {
      const stages = staged.filter((entry) => entry.name === name);
      const result = stages.some((entry) => entry.mode === "160000")
        ? { conflict: null }
        : await mergeStages(
            cwd,
            name,
            stages.map((entry) => ({ ...parseEntry(`${entry.mode} blob ${entry.oid}\t${name}`), stage: entry.stage })),
            temporary,
            ["current", "base", "incoming"],
          );
      if ("conflict" in result) conflicts.push(name);
      else
        await command(cwd, ["update-index", "-z", "--index-info"], {
          index,
          input: Buffer.from(`0 ${"0".repeat(result.entry.oid.length)}\t${name}\0${result.entry.mode} ${result.entry.oid}\t${name}\0`),
        });
    }
    if (conflicts.length) return { conflicts };
    return { tree: text((await command(cwd, ["write-tree"], { index })).stdout).trim() };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Prefer a resolved entry, then destination, incoming and base when displaying an unresolved index. */
function previewStagePriority(stage: number): number {
  if (stage === 0) return 3;
  if (stage === 2) return 2;
  if (stage === 3) return 1;
  return 0;
}

/** Rebuild only the disposable merge worktree from the alternate index, including conflict-marker bytes. */
async function materializeMergePreview(input: { cwd: string; worktreePath: string; indexPath: string; destinationTree: string; conflictContents: ReadonlyMap<string, Buffer> }): Promise<StageEntry[]> {
  const { cwd, worktreePath, indexPath, destinationTree, conflictContents } = input;
  const visible = await indexEntries(worktreePath, indexPath);
  const files = (await listTree(cwd, destinationTree)).map((entry) => entry.path).sort((a, b) => b.length - a.length);
  for (const name of files) await rm(path.join(worktreePath, name), { force: true });
  // Remove empty directories too so file↔directory edits remain representable.
  const dirs = new Set(
    files.flatMap((name) => {
      const parts = name.split("/");
      return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
    }),
  );
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) await rm(path.join(worktreePath, dir), { recursive: true, force: true });
  const shown = new Map<string, StageEntry>();
  for (const entry of visible) if (!shown.has(entry.path) || previewStagePriority(entry.stage) > previewStagePriority(shown.get(entry.path)!.stage)) shown.set(entry.path, entry);
  for (const entry of shown.values()) {
    // A directory/file conflict may retain both paths in the index. Preserve
    // those stages there without writing through another entry's symlink/file.
    if ([...shown.keys()].some((name) => entry.path.startsWith(`${name}/`))) continue;
    await writeEntry(cwd, worktreePath, entry);
    const content = conflictContents.get(entry.path);
    if (content) await writeFile(path.join(worktreePath, entry.path), content);
  }
  return visible;
}

/**
 * Apply only baseTree→outputTree to a captured destination, in an isolated
 * worktree/index. Text merges use Git's builtin merge-file, never attributes or
 * external drivers. Binary/type/delete conflicts retain all index stages.
 * The caller owns scratch worktree and retention-ref cleanup, including failures.
 */
export async function stageMerge(cwd: string, options: { baseTree: string; outputTree: string; destinationTree: string; headSha: string; path: string; refPrefix: string }): Promise<TeamMergeResult> {
  for (const tree of [options.baseTree, options.outputTree, options.destinationTree]) await listTree(cwd, tree);
  const retainedRefs: string[] = [];
  for (const [name, oid] of [
    ["base", options.baseTree],
    ["output", options.outputTree],
    ["destination", options.destinationTree],
  ] as const) {
    const ref = `${options.refPrefix}/${name}`;
    await retainTree(cwd, oid, ref);
    retainedRefs.push(ref);
  }
  await retainObject(cwd, options.headSha, `${options.refPrefix}/head`);
  retainedRefs.push(`${options.refPrefix}/head`);
  await createWorktree(cwd, options.path, options.headSha, options.destinationTree);
  const indexPath = path.resolve(options.path, await output(options.path, ["rev-parse", "--git-path", `team-merge-index-${randomUUID()}`]));
  if (options.baseTree === options.destinationTree) await command(options.path, ["read-tree", options.outputTree], { index: indexPath });
  else if (options.baseTree === options.outputTree || options.destinationTree === options.outputTree) await command(options.path, ["read-tree", options.destinationTree], { index: indexPath });
  else await command(options.path, ["read-tree", "-m", "--aggressive", options.baseTree, options.destinationTree, options.outputTree], { index: indexPath });
  const staged = await indexEntries(options.path, indexPath);
  const conflictNames = [...new Set(staged.filter((entry) => entry.stage !== 0).map((entry) => entry.path))];
  const unresolved: string[] = [];
  const conflictContents = new Map<string, Buffer>();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "openorc-team-merge-"));
  try {
    for (const name of conflictNames) {
      const result = await mergeStages(
        cwd,
        name,
        staged.filter((entry) => entry.path === name),
        temporary,
        ["destination", "prepared input", "assignment output"],
      );
      if ("conflict" in result) {
        unresolved.push(name);
        if (result.conflict) conflictContents.set(name, result.conflict);
        continue;
      }
      const { mode, oid } = result.entry;
      await command(options.path, ["update-index", "-z", "--index-info"], { index: indexPath, input: Buffer.from(`0 ${"0".repeat(oid.length)}\t${name}\0${mode} ${oid}\t${name}\0`) });
    }
    // Never run reset/checkout in the destination.
    const visible = await materializeMergePreview({ cwd, worktreePath: options.path, indexPath, destinationTree: options.destinationTree, conflictContents });
    if (unresolved.length) {
      // Alternate index files are not GC roots. Retain newly merged stage-0
      // blobs too; the three input refs retain every unresolved stage.
      const retainedIndex = path.join(temporary, "retained-index");
      await writeIndex(
        cwd,
        retainedIndex,
        visible.filter((entry) => entry.stage === 0),
      );
      const partialTree = text((await command(cwd, ["write-tree"], { index: retainedIndex })).stdout).trim();
      const partialRef = `${options.refPrefix}/partial-tree`;
      await retainTree(cwd, partialTree, partialRef);
      retainedRefs.push(partialRef);
      return { status: "conflict", conflicts: unresolved, worktreePath: options.path, indexPath, retainedRefs };
    }
    const treeSha = text((await command(options.path, ["write-tree"], { index: indexPath })).stdout).trim();
    const treeRef = `${options.refPrefix}/tree`;
    await retainTree(cwd, treeSha, treeRef);
    retainedRefs.push(treeRef);
    return { status: "clean", treeSha, treeRef, worktreePath: options.path, indexPath, retainedRefs };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function workingEntryMode(stat: BigIntStats): TeamTreeEntry["mode"] {
  if (stat.isSymbolicLink()) return "120000";
  if ((stat.mode & 0o111n) !== 0n) return "100755";
  return "100644";
}

function compareEntryPaths(a: TeamTreeEntry, b: TeamTreeEntry): number {
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

function mergedEntryMode({ base, ours, theirs }: { base: TeamTreeEntry["mode"]; ours: TeamTreeEntry["mode"]; theirs: TeamTreeEntry["mode"] }): TeamTreeEntry["mode"] | null {
  if (ours === base) return theirs;
  if (theirs === base || ours === theirs) return ours;
  return null;
}
