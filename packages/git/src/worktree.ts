import { git, GitError } from "./exec.js";

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
}

export async function list(root: string): Promise<WorktreeEntry[]> {
  const out = (await git(root, ["worktree", "list", "--porcelain"])).stdout;
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), head: null, branch: null, locked: false, prunable: false };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (line.startsWith("locked")) {
      current.locked = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a worktree on a new branch from `startPoint`. If the branch already
 * exists (a task being reopened), the worktree checks it out instead.
 */
export async function add(root: string, options: { path: string; branch: string; startPoint: string }): Promise<void> {
  if (await branchExists(root, options.branch)) {
    await git(root, ["worktree", "add", options.path, options.branch]);
  } else {
    await git(root, ["worktree", "add", "-b", options.branch, options.path, options.startPoint]);
  }
}

/**
 * Commits everything a worktree has not committed onto its branch, new files included and ignored ones not, so the
 * worktree can be removed without losing work. Commit hooks are skipped: this keeps work rather than changing it.
 * Returns the commit and how many paths it saved, or null when there was nothing to save.
 */
export async function saveChanges(worktreePath: string, message: string): Promise<{ sha: string; paths: number } | null> {
  const changed = (await git(worktreePath, ["status", "--porcelain"])).stdout.split("\n").filter(Boolean);
  if (changed.length === 0) return null;
  const branch = (await git(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"], { okCodes: [0, 1] })).stdout.trim();
  if (!branch) throw new Error("This worktree is not on a branch, so its uncommitted changes have nowhere to be saved. Commit them to a branch first.");
  await git(worktreePath, ["add", "-A"]);
  try {
    await git(worktreePath, ["commit", "--no-verify", "--quiet", "-m", message]);
  } catch (e) {
    if (e instanceof GitError && /tell me who you are|user\.(email|name)/i.test(e.stderr))
      throw new Error("Git has no user name or email set, so the uncommitted changes could not be saved. Set them with git config, then try again.");
    throw e;
  }
  return { sha: (await git(worktreePath, ["rev-parse", "HEAD"])).stdout.trim(), paths: changed.length };
}

export async function remove(root: string, worktreePath: string, options: { force?: boolean } = {}): Promise<void> {
  const args = ["worktree", "remove"];
  if (options.force) args.push("--force", "--force");
  args.push(worktreePath);
  await git(root, args);
}

export async function lock(root: string, worktreePath: string, reason: string): Promise<void> {
  try {
    await git(root, ["worktree", "lock", "--reason", reason, worktreePath]);
  } catch (e) {
    // Already locked is fine.
    if (!(e instanceof GitError && /already locked/.test(e.stderr))) throw e;
  }
}

export async function unlock(root: string, worktreePath: string): Promise<void> {
  try {
    await git(root, ["worktree", "unlock", worktreePath]);
  } catch (e) {
    if (!(e instanceof GitError && /not locked/.test(e.stderr))) throw e;
  }
}

export async function prune(root: string): Promise<void> {
  await git(root, ["worktree", "prune"]);
}

export async function deleteBranch(root: string, branch: string, options: { force?: boolean } = {}): Promise<void> {
  await git(root, ["branch", options.force ? "-D" : "-d", branch]);
}

/** The commit a branch points to, or null when there is no such branch. */
export async function branchTip(root: string, branch: string): Promise<string | null> {
  const out = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { okCodes: [0, 1] });
  return out.code === 0 ? out.stdout.trim() : null;
}

/** How many commits on `branch` no other branch, remote-tracking branch or tag reaches: what deleting it would lose. */
export async function commitsOnlyOn(root: string, branch: string): Promise<number> {
  const out = await git(root, ["rev-list", "--count", `refs/heads/${branch}`, "--not", `--exclude=${branch}`, "--branches", "--remotes", "--tags"]);
  return Number(out.stdout.trim());
}

/** Deletes a branch only while it still points at `tip`, so commits added after that check are never lost. */
export async function deleteBranchAt(root: string, branch: string, tip: string): Promise<void> {
  await git(root, ["update-ref", "-d", `refs/heads/${branch}`, tip]);
}
