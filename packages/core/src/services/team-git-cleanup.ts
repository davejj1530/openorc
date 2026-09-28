import { git, worktree } from "@openorc/git";
import type { TeamDeletionGitInventory } from "@openorc/db";

export interface TeamGitCleanupOutcome {
  deletedBranches: string[];
  retainedBranches: { name: string; reason: string }[];
  deletedRefs: number;
}

/** Capture the current tips of the owned branch names that exist; absent names are simply not owned work. */
export async function inventoryTeamGit(root: string, names: Iterable<string>, refPrefixes: Iterable<string>): Promise<TeamDeletionGitInventory> {
  const branches: TeamDeletionGitInventory["branches"] = [];
  for (const name of new Set(names)) {
    const tip = await branchTip(root, name);
    if (tip) branches.push({ name, tip });
  }
  return { branches, refPrefixes: [...new Set(refPrefixes)].sort() };
}

async function branchTip(root: string, name: string): Promise<string | null> {
  const result = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`], { okCodes: [0, 1] });
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Retention refs are ours and go unconditionally. A branch goes only at its
 * captured tip, when nothing has it checked out, and when its commits are
 * already merged into the default branch or pushed; otherwise it stays and says why.
 */
export async function collectTeamGit(root: string, inventory: TeamDeletionGitInventory, defaultBranch: string | null, assertCurrent: () => void): Promise<TeamGitCleanupOutcome> {
  const outcome: TeamGitCleanupOutcome = { deletedBranches: [], retainedBranches: [], deletedRefs: 0 };
  for (const prefix of inventory.refPrefixes) {
    assertCurrent();
    const refs = (await git(root, ["for-each-ref", "--format=%(refname)", prefix])).stdout.split("\n").filter(Boolean);
    for (const ref of refs) {
      await git(root, ["update-ref", "-d", ref]);
      outcome.deletedRefs += 1;
    }
  }
  if (!inventory.branches.length) return outcome;
  const checkouts = await worktree.list(root);
  for (const branch of inventory.branches) {
    assertCurrent();
    const tip = await branchTip(root, branch.name);
    if (!tip) {
      outcome.deletedBranches.push(branch.name);
      continue;
    }
    const retain = (reason: string) => outcome.retainedBranches.push({ name: branch.name, reason });
    if (tip !== branch.tip) {
      retain("changed after the deletion was captured");
      continue;
    }
    const checkout = checkouts.find((entry) => entry.branch === branch.name);
    if (checkout) {
      retain(`checked out at ${checkout.path}`);
      continue;
    }
    const merged = defaultBranch !== null && (await git(root, ["merge-base", "--is-ancestor", tip, `refs/heads/${defaultBranch}`], { okCodes: [0, 1, 128] })).code === 0;
    const pushed = (await git(root, ["for-each-ref", "--format=%(objectname)", `refs/remotes/*/${branch.name}`])).stdout.split("\n").includes(tip);
    if (!merged && !pushed) {
      retain(`has commits that are neither merged into ${defaultBranch ?? "the default branch"} nor pushed`);
      continue;
    }
    await git(root, ["update-ref", "-d", `refs/heads/${branch.name}`, tip]);
    outcome.deletedBranches.push(branch.name);
  }
  return outcome;
}
