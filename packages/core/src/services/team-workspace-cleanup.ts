import { lstat, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { BigIntStats } from "node:fs";
import type { TeamCleanupEntry, TeamCleanupPhase } from "@openorc/db";
import { git } from "@openorc/git";

type Identity = NonNullable<TeamCleanupEntry["identity"]>;
export interface TeamCleanupHooks {
  fault?(point: "after-quarantine" | "before-remove" | "after-remove", entry: TeamCleanupEntry): Promise<void> | void;
}
interface Registered {
  path: string;
  head: string;
  branch: string | null;
  locked: boolean;
}
const identity = (stat: BigIntStats): Identity => ({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) });
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const contains = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
/** True when `child` is `parent` or lives underneath it. */
export const pathContains = contains;
const line = (text: string) => (text.endsWith("\n") ? text.slice(0, -1) : text);
async function stat(file: string): Promise<BigIntStats | null> {
  return lstat(file, { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
}
async function physical(file: string): Promise<string> {
  let ancestor = path.resolve(file);
  const absent: string[] = [];
  for (;;) {
    const existing = await stat(ancestor);
    if (existing) return path.join(await realpath(ancestor), ...absent);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("Cleanup path cannot be resolved.");
    absent.unshift(path.basename(ancestor));
    ancestor = parent;
  }
}
function absolute(file: string): void {
  if (!path.isAbsolute(file) || path.normalize(file) !== file) throw new Error("Cleanup requires normalized absolute paths.");
}
async function registrations(repository: string): Promise<Registered[]> {
  const fields = (await git(repository, ["worktree", "list", "--porcelain", "-z"])).stdout.split("\0");
  const result: Registered[] = [];
  let current: Registered | null = null;
  for (const field of fields) {
    if (field.startsWith("worktree ")) {
      current = { path: field.slice(9), head: "", branch: null, locked: false };
      result.push(current);
    } else if (current && field.startsWith("HEAD ")) current.head = field.slice(5);
    else if (current && field.startsWith("branch ")) current.branch = field.slice(7);
    else if (current && (field === "locked" || field.startsWith("locked "))) current.locked = true;
  }
  return result;
}
async function repositoryIdentity(repository: string): Promise<{ root: string; common: string }> {
  const root = await realpath(line((await git(repository, ["rev-parse", "--show-toplevel"])).stdout));
  const common = await realpath(line((await git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout));
  return { root, common };
}
function protect(entry: Pick<TeamCleanupEntry, "canonicalPath" | "quarantinePath" | "repositoryRoot" | "commonDir">): void {
  for (const candidate of [entry.canonicalPath, entry.quarantinePath]) {
    if ([entry.repositoryRoot, entry.commonDir].some((root) => contains(root, candidate) || contains(candidate, root)))
      throw new Error("Cleanup cannot remove or overlap the project checkout or Git metadata.");
  }
  if (entry.canonicalPath === entry.quarantinePath || path.dirname(entry.canonicalPath) !== path.dirname(entry.quarantinePath))
    throw new Error("Cleanup quarantine must be a separate sibling on the same filesystem.");
}
async function readRegistration(repository: string, common: string, candidate: string): Promise<TeamCleanupEntry["registration"]> {
  const rows = await registrations(repository);
  const matching = [];
  for (const row of rows) if ((await physical(row.path)) === candidate) matching.push(row);
  const markerStat = await stat(path.join(candidate, ".git"));
  if (!matching.length && !markerStat) return null;
  if (matching.length !== 1 || !markerStat?.isFile() || markerStat.isSymbolicLink())
    throw new Error("Cleanup requires an exact registered linked worktree; foreign repositories and Git marker links are preserved.");
  const row = matching[0]!;
  if (row.locked) throw new Error("The worktree is locked. Unlock it explicitly before cleanup.");
  const marker = await readFile(path.join(candidate, ".git"), "utf8");
  if (!marker.startsWith("gitdir: ")) throw new Error("The linked worktree marker changed.");
  const declared = path.resolve(candidate, line(marker.slice(8)));
  const admin = await stat(declared);
  if (!admin?.isDirectory() || admin.isSymbolicLink()) throw new Error("The worktree registration is not a retained directory.");
  const gitDir = await realpath(declared);
  if (path.dirname(gitDir) !== path.join(common, "worktrees")) throw new Error("The linked worktree belongs to another repository.");
  const declaredCommon = await realpath(path.resolve(gitDir, line(await readFile(path.join(gitDir, "commondir"), "utf8"))));
  const backlink = await physical(line(await readFile(path.join(gitDir, "gitdir"), "utf8")));
  if (declaredCommon !== common || backlink !== path.join(candidate, ".git")) throw new Error("The worktree registration no longer points to this exact directory.");
  return { gitDir, gitDirIdentity: identity(admin), marker, head: row.head, branch: row.branch };
}

/** Caller proves app ownership and reserves the directory before inspecting it. */
export async function inspectTeamCleanup(input: { repositoryRoot: string; path: string; quarantinePath: string; allowPartialDirectory?: boolean }): Promise<TeamCleanupEntry> {
  absolute(input.repositoryRoot);
  absolute(input.path);
  absolute(input.quarantinePath);
  const repository = await repositoryIdentity(input.repositoryRoot);
  const raw = await stat(input.path);
  if (raw && (!raw.isDirectory() || raw.isSymbolicLink())) throw new Error("Cleanup refuses a symlink or non-directory workspace.");
  const canonicalPath = await physical(input.path),
    quarantinePath = await physical(input.quarantinePath);
  const entry: TeamCleanupEntry = {
    path: input.path,
    canonicalPath,
    repositoryRoot: repository.root,
    commonDir: repository.common,
    quarantinePath,
    identity: raw ? identity(raw) : null,
    registration: null,
  };
  protect(entry);
  if (await stat(quarantinePath)) throw new Error("Cleanup needs a new, unused quarantine path.");
  if (raw) {
    entry.registration = await readRegistration(repository.root, repository.common, canonicalPath);
    if (!entry.registration && !input.allowPartialDirectory) throw new Error("An unregistered directory requires explicit retained app ownership before cleanup.");
  }
  return entry;
}

async function verifyDirectory(entry: TeamCleanupEntry, target: string): Promise<void> {
  const actual = await stat(target);
  if (!actual?.isDirectory() || actual.isSymbolicLink() || !entry.identity || !same(identity(actual), entry.identity) || (await realpath(target)) !== target)
    throw new Error("The cleanup directory was replaced. Its current files were preserved.");
  if (!entry.registration) {
    if (await stat(path.join(target, ".git"))) throw new Error("The partial workspace became a repository. Its files were preserved.");
    return;
  }
  const marker = await stat(path.join(target, ".git"));
  if (!marker?.isFile() || marker.isSymbolicLink() || (await readFile(path.join(target, ".git"), "utf8")) !== entry.registration.marker)
    throw new Error("The worktree Git marker changed. Its files were preserved.");
  const admin = await stat(entry.registration.gitDir);
  if (!admin?.isDirectory() || admin.isSymbolicLink() || !same(identity(admin), entry.registration.gitDirIdentity))
    throw new Error("The worktree registration was replaced. Its files were preserved.");
  if (await stat(path.join(entry.registration.gitDir, "locked"))) throw new Error("The worktree was locked after cleanup was requested.");
  const declaredCommon = await realpath(path.resolve(entry.registration.gitDir, line(await readFile(path.join(entry.registration.gitDir, "commondir"), "utf8"))));
  if (declaredCommon !== entry.commonDir) throw new Error("The worktree registration points to another repository.");
  const backlink = await physical(line(await readFile(path.join(entry.registration.gitDir, "gitdir"), "utf8")));
  if (![entry.canonicalPath, entry.quarantinePath].some((candidate) => backlink === path.join(candidate, ".git"))) throw new Error("The worktree registration points to another directory.");
  const currentHead = line((await git(target, ["rev-parse", "HEAD"])).stdout);
  const currentBranch = line((await git(target, ["symbolic-ref", "-q", "HEAD"], { okCodes: [0, 1] })).stdout) || null;
  if (currentHead !== entry.registration.head || currentBranch !== entry.registration.branch) throw new Error("The worktree Git history changed after cleanup was requested.");
}

/** Cancellation is available only while the original directories are still intact. */
export async function assertTeamCleanupUntouched(entry: TeamCleanupEntry): Promise<void> {
  if (await stat(entry.quarantinePath)) throw new Error("Deletion already moved some files. Finish deleting while keeping the remaining files instead.");
  if (entry.identity) await verifyDirectory(entry, entry.canonicalPath);
  else if (await stat(entry.canonicalPath)) throw new Error("A previously missing workspace now contains files. They were preserved.");
}

/** A durable quarantine makes retries independent of any recreated original path. */
export async function removeTeamCleanup(
  entry: TeamCleanupEntry,
  phase: TeamCleanupPhase,
  progress: (phase: TeamCleanupPhase) => Promise<void> | void,
  assertCurrent: () => void,
  hooks: TeamCleanupHooks = {},
): Promise<void> {
  if (phase === "removed") return;
  protect(entry);
  assertCurrent();
  const repository = await repositoryIdentity(entry.repositoryRoot);
  if (repository.root !== entry.repositoryRoot || repository.common !== entry.commonDir) throw new Error("The cleanup repository changed.");
  if (!entry.identity) {
    if ((await stat(entry.canonicalPath)) || (await stat(entry.quarantinePath))) throw new Error("A previously missing cleanup path now contains files. They were preserved.");
    assertCurrent();
    await progress("removed");
    return;
  }
  let quarantined = await stat(entry.quarantinePath);
  if (!quarantined) {
    const source = await stat(entry.canonicalPath);
    if (source) {
      if (phase === "quarantined") throw new Error("The quarantined workspace is missing and the original path was recreated. Its files were preserved.");
      await verifyDirectory(entry, entry.canonicalPath);
      assertCurrent();
      // The unique sibling is journaled before this atomic rename. Recheck the
      // moved inode before any removal so a swapped source cannot be destroyed.
      if (await stat(entry.quarantinePath)) throw new Error("The quarantine path is already occupied.");
      await rename(entry.canonicalPath, entry.quarantinePath);
      await verifyDirectory(entry, entry.quarantinePath);
      quarantined = await stat(entry.quarantinePath);
    } else {
      // A completed Git removal deletes its exact admin directory too. When only
      // the files vanished, remove the captured admin directory itself after
      // proving its identity and backlink; never a global prune.
      const admin = entry.registration ? await stat(entry.registration.gitDir) : null;
      if (entry.registration && admin) {
        if (!admin.isDirectory() || admin.isSymbolicLink() || !same(identity(admin), entry.registration.gitDirIdentity)) throw new Error("The worktree registration was replaced. It was preserved.");
        const backlink = await physical(line(await readFile(path.join(entry.registration.gitDir, "gitdir"), "utf8")));
        if (![entry.canonicalPath, entry.quarantinePath].some((candidate) => backlink === path.join(candidate, ".git")))
          throw new Error("The worktree registration points to another directory. It was preserved.");
        assertCurrent();
        await hooks.fault?.("before-remove", entry);
        await rm(entry.registration.gitDir, { recursive: true, force: false });
        await hooks.fault?.("after-remove", entry);
      }
      assertCurrent();
      if (phase === "pending") await progress("quarantined");
      await progress("removed");
      return;
    }
  }
  if (!quarantined) throw new Error("The quarantined workspace disappeared during cleanup.");
  await verifyDirectory(entry, entry.quarantinePath);
  assertCurrent();
  // Journal the quarantine before anything else can fail; a retry then only ever looks at the unique sibling.
  if (phase === "pending") {
    await progress("quarantined");
    phase = "quarantined";
  }
  await hooks.fault?.("after-quarantine", entry);
  if (entry.registration) {
    await git(entry.repositoryRoot, ["worktree", "repair", entry.quarantinePath]);
    await verifyDirectory(entry, entry.quarantinePath);
    const repaired = await readRegistration(entry.repositoryRoot, entry.commonDir, entry.quarantinePath);
    if (repaired?.gitDir !== entry.registration.gitDir) throw new Error("Cleanup repaired a different worktree registration.");
  }
  await hooks.fault?.("before-remove", entry);
  await verifyDirectory(entry, entry.quarantinePath);
  assertCurrent();
  if (entry.registration) await git(entry.repositoryRoot, ["worktree", "remove", "--force", "--", entry.quarantinePath]);
  else await rm(entry.quarantinePath, { recursive: true, force: false });
  await hooks.fault?.("after-remove", entry);
  if ((await stat(entry.quarantinePath)) || (entry.registration && (await stat(entry.registration.gitDir)))) throw new Error("Cleanup did not finish removing its exact workspace and registration.");
  assertCurrent();
  await progress("removed");
}
