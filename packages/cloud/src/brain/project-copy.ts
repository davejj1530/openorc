/**
 * A Mac project's copy on the cloud brain, moved through git bundles of its default branch: the Mac bundles what the copy
 * lacks, and the brain takes it. Only the branch's commits cross; GitHub stays the copy's origin.
 */
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitError, git, originUrl, revParse } from "@openorc/git";

/** Where a copy keeps the Mac's branch as last taken, so each later bundle builds on it whatever the copy's branch does. */
const macRef = (branch: string) => `refs/openorc/mac/${branch}`;

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
  const checkedOut = (await git(folder, ["symbolic-ref", "--quiet", "HEAD"], { okCodes: [0, 1] })).stdout.trim() === `refs/heads/${branch}`;
  if (local === null) await git(folder, checkedOut ? ["checkout", "--quiet", "-B", branch, macHead] : ["branch", branch, macHead]);
  else if (local !== macHead && (await isAncestor(folder, local, macHead)))
    await git(folder, checkedOut ? ["merge", "--ff-only", "--quiet", macHead] : ["update-ref", `refs/heads/${branch}`, macHead, local]).catch((error: unknown) => {
      throw error instanceof GitError && error.stderr.includes("would be overwritten") ? new Error("The cloud copy has uncommitted changes in the way.") : error;
    });
  await git(folder, ["update-ref", macRef(branch), macHead]);
  await git(folder, ["update-ref", "-d", incoming]);
  return { macHead, head: (await branchHead(folder, branch)) ?? macHead };
}

/** What a copy last took from the Mac and its own branch's commit; null for a folder that holds no copy. */
export async function copyHeads(folder: string): Promise<{ macHead: string; head: string } | null> {
  const refs = await git(folder, ["for-each-ref", "--count=1", "--format=%(objectname) %(refname)", "refs/openorc/mac/"]).catch(() => null);
  const [macHead, ref] = refs?.stdout.trim().split(" ") ?? [];
  if (!macHead || !ref) return null;
  return { macHead, head: (await branchHead(folder, ref.slice("refs/openorc/mac/".length))) ?? macHead };
}

async function followOrigin(folder: string, origin: string | null): Promise<void> {
  const current = await originUrl(folder);
  if (current === origin) return;
  if (origin === null) await git(folder, ["remote", "remove", "origin"]);
  else await git(folder, current === null ? ["remote", "add", "origin", origin] : ["remote", "set-url", "origin", origin]);
}
