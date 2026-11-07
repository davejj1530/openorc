/**
 * A Mac project's copy on the cloud brain, moved through git bundles of its default branch: the Mac bundles what the copy
 * lacks, and the brain takes it. Only the branch's commits cross; GitHub stays the copy's origin.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitError, git, originUrl, revParse } from "@openorc/git";

/** Where a copy keeps the Mac's branch as last taken, so each later bundle builds on it whatever the copy's branch does. */
const MAC_REFS = "refs/openorc/mac/";
const macRef = (branch: string) => `${MAC_REFS}${branch}`;
/** When a copy last took the Mac's branch or heard its origin's, in ms, beside its git: reading it runs no git. */
const SYNCED = "openorc-synced";

/** The commit a branch is on; null when the repository has no such branch, or no commit on it. */
export async function branchHead(root: string, branch: string): Promise<string | null> {
  return (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { okCodes: [0, 1] })).stdout.trim() || null;
}

/** False too when either commit is unknown here. */
async function isAncestor(root: string, older: string, newer: string): Promise<boolean> {
  return (await git(root, ["merge-base", "--is-ancestor", older, newer], { okCodes: [0, 1, 128] })).code === 0;
}

/**
 * A bundle of `branch` with its history: only what came after `since` when that is an earlier commit on the branch, as a
 * copy that took `since` needs, else the whole branch.
 */
export async function bundleBranch(root: string, branch: string, since: string | null): Promise<{ bytes: Buffer; incremental: boolean }> {
  const head = await revParse(root, `refs/heads/${branch}`);
  const incremental = since !== null && since !== head && (await isAncestor(root, since, head));
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-project-"));
  try {
    const file = path.join(dir, "project.bundle");
    await git(root, ["bundle", "create", "-q", file, `refs/heads/${branch}`, ...(incremental ? [`^${since}`] : [])]);
    return { bytes: await readFile(file), incremental };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** What a copy took of a bundle: the Mac's commit and its own, or nothing, since it lacks the commit the bundle builds on. */
export type Taken = { macHead: string; head: string } | { lacksBase: true };

/**
 * The brain's side: takes the Mac's `branch` from `bundle` into the copy at `folder`, made the first time. The copy's
 * branch fast-forwards to the Mac's, unless it has commits the Mac's lacks: those stay, and `head` says so by differing
 * from `macHead`. Its origin follows the Mac's. Only once the branch is where it should be does the copy record the
 * Mac's commit as taken, so a take that fails or stops halfway is taken again in full. Taking a bundle again changes
 * nothing.
 */
export async function takeBranch(folder: string, bundle: string, branch: string, origin: string | null): Promise<Taken> {
  const fresh = !(await stat(path.join(folder, ".git")).catch(() => null));
  if (fresh) {
    // A folder without its git holds nothing of the copy's.
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });
    await git(folder, ["init", "--quiet", "--initial-branch", branch]);
  }
  if ((await git(folder, ["bundle", "verify", "--quiet", bundle], { okCodes: [0, 1] })).code !== 0) {
    if (fresh) await rm(folder, { recursive: true, force: true });
    return { lacksBase: true };
  }
  const incoming = `refs/openorc/incoming/${branch}`;
  await git(folder, ["fetch", "--quiet", "--no-tags", bundle, `+refs/heads/${branch}:${incoming}`]);
  await followOrigin(folder, origin);
  const macHead = await revParse(folder, incoming);
  const local = await branchHead(folder, branch);
  if (local === null || (local !== macHead && (await isAncestor(folder, local, macHead)))) await moveBranch(folder, branch, local, macHead);
  await follow(folder, branch, macHead);
  await git(folder, ["update-ref", "-d", incoming]);
  await markSynced(folder);
  return { macHead, head: (await branchHead(folder, branch)) ?? macHead };
}

/**
 * The copy follows `branch` from now on, the one the Mac's commit is kept for, as when the Mac's default moved from master
 * to main. A copy that had the branch it followed before checked out moves its checkout too; one on another branch or a
 * detached HEAD keeps it. The old branch stays for threads that started from it.
 */
async function follow(folder: string, branch: string, macHead: string): Promise<void> {
  await git(folder, ["update-ref", macRef(branch), macHead]);
  const before = (await git(folder, ["for-each-ref", "--format=%(refname)", MAC_REFS])).stdout.split("\n").filter((ref) => ref && ref !== macRef(branch));
  for (const ref of before) await git(folder, ["update-ref", "-d", ref]);
  const checkedOut = (await git(folder, ["symbolic-ref", "--quiet", "HEAD"], { okCodes: [0, 1] })).stdout.trim();
  if (!before.some((ref) => checkedOut === `refs/heads/${ref.slice(MAC_REFS.length)}`)) return;
  await git(folder, ["checkout", "--quiet", branch]).catch((error: unknown) => {
    throw error instanceof GitError && error.stderr.includes("would be overwritten") ? new Error("The cloud copy has uncommitted changes in the way.") : error;
  });
}

/** Puts `branch` on `target`: made there, or fast-forwarded, its files following when the copy has it checked out. */
async function moveBranch(folder: string, branch: string, local: string | null, target: string): Promise<void> {
  const checkedOut = (await git(folder, ["symbolic-ref", "--quiet", "HEAD"], { okCodes: [0, 1] })).stdout.trim() === `refs/heads/${branch}`;
  if (local === null) await git(folder, checkedOut ? ["checkout", "--quiet", "-B", branch, target] : ["branch", branch, target]);
  else
    await git(folder, checkedOut ? ["merge", "--ff-only", "--quiet", target] : ["update-ref", `refs/heads/${branch}`, target, local]).catch((error: unknown) => {
      throw error instanceof GitError && error.stderr.includes("would be overwritten") ? new Error("The cloud copy has uncommitted changes in the way.") : error;
    });
}

/** What a copy's branch did when compared with its origin's before a thread started from it. */
export type OriginCatchUp = "updated" | "current" | "kept" | "unreachable" | "no-origin";

/**
 * Before a thread starts from a copy: its branch fast-forwards to its origin's (GitHub's) when that is ahead and the copy
 * has nothing of its own; a copy with commits its origin lacks, such as the Mac's unpushed work, stays as it is. The fetch
 * is cut off after `timeoutMs`, so an origin out of reach holds a start up that long at most. A private origin needs the
 * GitHub sign-in the brain's own git holds; a public one needs none.
 */
export async function catchUpWithOrigin(folder: string, branch: string, timeoutMs = 8_000): Promise<OriginCatchUp> {
  if (!(await originUrl(folder))) return "no-origin";
  const fetched = `refs/openorc/origin/${branch}`;
  const reached = await git(folder, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:${fetched}`], { timeoutMs }).then(
    () => true,
    () => false,
  );
  if (!reached) return "unreachable";
  await markSynced(folder);
  const origin = await revParse(folder, fetched);
  const local = await branchHead(folder, branch);
  if (local === origin) return "current";
  if (local !== null && !(await isAncestor(folder, local, origin))) return "kept";
  await moveBranch(folder, branch, local, origin);
  return "updated";
}

async function markSynced(folder: string): Promise<void> {
  await writeFile(path.join(folder, ".git", SYNCED), String(Date.now()));
}

/** The Mac found its branch where the copy took it last: the copy counts as synced now. False once it took another since. */
export async function confirmSynced(folder: string, macHead: string): Promise<boolean> {
  if ((await copyHeads(folder))?.macHead !== macHead) return false;
  await markSynced(folder);
  return true;
}

/** When the copy at `folder` last took the Mac's branch or heard its origin's; null for a folder that holds no copy. */
export async function copySyncedAt(folder: string): Promise<number | null> {
  const at = Number(await readFile(path.join(folder, ".git", SYNCED), "utf8").catch(() => ""));
  return Number.isFinite(at) && at > 0 ? at : null;
}

/** What a copy last took from the Mac and its own branch's commit; null for a folder that holds no copy. */
export async function copyHeads(folder: string): Promise<{ macHead: string; head: string } | null> {
  const refs = await git(folder, ["for-each-ref", "--count=1", "--format=%(objectname) %(refname)", MAC_REFS]).catch(() => null);
  const [macHead, ref] = refs?.stdout.trim().split(" ") ?? [];
  if (!macHead || !ref) return null;
  return { macHead, head: (await branchHead(folder, ref.slice(MAC_REFS.length))) ?? macHead };
}

async function followOrigin(folder: string, origin: string | null): Promise<void> {
  const current = await originUrl(folder);
  if (current === origin) return;
  if (origin === null) await git(folder, ["remote", "remove", "origin"]);
  else await git(folder, current === null ? ["remote", "add", "origin", origin] : ["remote", "set-url", "origin", origin]);
}
