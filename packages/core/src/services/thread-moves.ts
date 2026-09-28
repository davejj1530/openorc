import { randomUUID } from "node:crypto";
import { threads, type Db } from "@openorc/db";
import { git, pinObject, switchFiles, teamTransfer, treeHash, unpinAll, worktree, type TreeDeltaEntry } from "@openorc/git";
import type { ChangePreview, FileChange, Project, Thread } from "@openorc/protocol";
import { checkoutBranch } from "./checkout-branch.js";
import type { WorkspaceService } from "./workspace.js";
import type { WorkspaceLease } from "./workspace-writers.js";

const REFS = "refs/openorc/thread-moves";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const listed = (paths: string[]) => (paths.length > 5 ? `${paths.slice(0, 5).join(", ")} and ${paths.length - 5} more` : paths.join(", "));
export const fileChanges = (entries: TreeDeltaEntry[]): FileChange[] => entries.map((entry) => ({ path: entry.path, status: entryChange(entry), oldPath: null }));

/**
 * A move carries each file as it is on disk. A staged version that differs from both the last commit and the file
 * would be dropped, so the move stops instead and names the files.
 */
async function assertNothingPartlyStaged(cwd: string): Promise<void> {
  const changed = async (args: string[]) => new Set((await git(cwd, [...args, "--name-only", "-z"])).stdout.split("\0").filter(Boolean));
  const staged = await changed(["diff", "--cached"]);
  const unstaged = await changed(["diff"]);
  const partly = [...staged].filter((file) => unstaged.has(file));
  if (partly.length > 0) throw new Error(`${listed(partly)} ${partly.length === 1 ? "has" : "have"} staged changes that differ from the file on disk. Commit or unstage them, then move again.`);
}

export interface MoveResult {
  thread: Thread;
  /** How many files moved. */
  files: number;
}

/**
 * Moves a conversation's uncommitted work between the project checkout and a worktree of its own. Both sides are
 * read as trees, untracked files included, and files change through Git's own checkout, so filters such as Git LFS
 * and line endings apply and the staged changes in each real index stay as they are. Git refuses, changing nothing,
 * when a file changed after it was read. Nothing leaves the source until the destination holds it, and every
 * uncommitted change in the source moves, whoever made it; the confirmation lists them.
 */
export class ThreadMoves {
  constructor(
    private readonly db: Db,
    private readonly workspaces: WorkspaceService,
  ) {}

  /** The files a move would carry, or why it cannot run. */
  async preview(thread: Thread, project: Project): Promise<ChangePreview> {
    const source = thread.workspaceMode === "current" ? project.rootPath : thread.worktreePath;
    if (!source) return { files: [], blocked: null };
    try {
      await assertNothingPartlyStaged(source);
      const head = await this.head(source);
      const base = thread.workspaceMode === "current" ? await this.tree(source, head) : await this.worktreeBase(thread, project, head);
      return { files: fileChanges(await teamTransfer.treeDelta(project.rootPath, base, await treeHash(source), { submodules: "refuse" })), blocked: null };
    } catch (error) {
      return { files: [], blocked: `This conversation cannot move. ${message(error)}` };
    }
  }

  /**
   * Checkout to worktree. The worktree starts on a new branch at the checkout's HEAD and takes the changes as they
   * are. Only once it holds every file does the checkout go back to HEAD for those files and unstage them. A failure
   * before that removes only what the move created.
   */
  async toWorktree(thread: Thread, project: Project, lease: WorkspaceLease): Promise<MoveResult> {
    const root = project.rootPath;
    const pins = `${REFS}/${thread.id}/${randomUUID()}/`;
    try {
      await assertNothingPartlyStaged(root);
      const head = await this.head(root);
      const headTree = await this.tree(root, head);
      const source = await this.pinned(root, pins, "source", await treeHash(root));
      const moving = await teamTransfer.treeDelta(root, headTree, source, { submodules: "refuse" });
      const branch = await this.freeBranch(root, this.workspaces.threadBranch({ ...thread, branch: null }, project));
      let moved: Thread;
      try {
        moved = await this.workspaces.prepareThread({ ...thread, workspaceMode: "worktree", worktreePath: null, branch, baseSha: null }, project, "HEAD", lease);
        const target = moved.worktreePath!;
        if ((await this.head(target)) !== head) throw new Error("The checkout's HEAD changed during the move. Nothing was moved.");
        if (moving.length > 0) {
          // A setup script may have changed files; the moved files win, anything else it did stays.
          const prepared = await treeHash(target);
          const expected = await teamTransfer.overlayTree(root, prepared, moving);
          await switchFiles(target, prepared, expected);
          if ((await treeHash(target)) !== expected) throw new Error("The worktree did not end up with the moved files. Nothing was taken from the checkout.");
        }
      } catch (error) {
        await this.discardWorktree(thread, root, branch, head);
        throw error;
      }
      if (moving.length > 0) {
        try {
          await switchFiles(root, source, headTree);
        } catch (error) {
          throw new Error(`The conversation now works in its worktree, which has every moved file. The checkout still has them too, because a file there changed during the move. ${message(error)}`, {
            cause: error,
          });
        }
        await this.unstage(root, moving);
      }
      return { thread: moved, files: moving.length };
    } finally {
      await unpinAll(root, pins).catch(() => undefined);
    }
  }

  /**
   * Worktree to checkout. The worktree's work since its base merges into the checkout's current files; a file both
   * changed in ways Git cannot combine stops the move. The worktree is removed only if it still holds exactly what
   * moved, and its branch stays with any commits made on it.
   */
  async toCheckout(thread: Thread, project: Project, lease: WorkspaceLease, shared: boolean): Promise<MoveResult> {
    const root = project.rootPath;
    const home = async () => threads.update(this.db, thread.id, { workspaceMode: "current", worktreePath: null, baseSha: null, branch: await checkoutBranch(root) });
    // An unstarted worktree conversation still points at the checkout; there is nothing to carry.
    if (!thread.worktreePath) return { thread: await home(), files: 0 };
    await assertNothingPartlyStaged(thread.worktreePath);
    const pins = `${REFS}/${thread.id}/${randomUUID()}/`;
    try {
      const source = await this.pinned(root, pins, "source", await treeHash(thread.worktreePath));
      const destination = await this.pinned(root, pins, "destination", await treeHash(root));
      const base = await this.worktreeBase(thread, project, await this.head(thread.worktreePath), await this.head(root));
      const moving = await teamTransfer.treeDelta(root, base, source, { submodules: "refuse" });
      const merge = await teamTransfer.mergeTrees(root, { base, ours: destination, theirs: source });
      if ("conflicts" in merge)
        throw new Error(`These files changed in both the worktree and the checkout: ${listed(merge.conflicts)}. Nothing was moved. Commit or undo one side's changes, then move again.`);
      await switchFiles(root, destination, await this.pinned(root, pins, "merged", merge.tree));
      const moved = await home();
      if (!shared) {
        if ((await treeHash(thread.worktreePath)) !== source)
          throw new Error(`The conversation now works in the checkout, but its worktree changed during the move, so the worktree was kept at ${thread.worktreePath}.`);
        await this.workspaces.cleanupThread(thread, project, { save: false }, lease);
      }
      return { thread: moved, files: moving.length };
    } finally {
      await unpinAll(root, pins).catch(() => undefined);
    }
  }

  /** Keeps a tree for the length of the move, so `git gc` cannot remove it midway. */
  private async pinned(root: string, pins: string, name: string, tree: string): Promise<string> {
    await pinObject(root, `${pins}${name}`, tree);
    return tree;
  }

  /** The moved files leave the checkout's real index too: a staged version of one would otherwise stay behind. */
  private async unstage(root: string, moving: TreeDeltaEntry[]): Promise<void> {
    await git(root, ["reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: moving.map((entry) => entry.path).join("\0"), env: { GIT_LITERAL_PATHSPECS: "1" } });
  }

  /** Undoes a failed move to a worktree: removes the worktree it created, and its branch while nothing was committed on it. */
  private async discardWorktree(thread: Thread, root: string, branch: string, start: string): Promise<void> {
    const failed = threads.get(this.db, thread.id);
    if (failed?.worktreePath && failed.worktreePath !== thread.worktreePath) {
      await worktree.remove(root, failed.worktreePath, { force: true }).catch(() => undefined);
      await worktree.prune(root).catch(() => undefined);
    }
    if ((await worktree.branchTip(root, branch)) === start) await worktree.deleteBranchAt(root, branch, start).catch(() => undefined);
    threads.update(this.db, thread.id, { workspaceMode: thread.workspaceMode, worktreePath: thread.worktreePath, baseSha: thread.baseSha, branch: thread.branch });
  }

  /** The conversation's own branch name, or the first free variant of it, so a move never adopts an existing branch. */
  private async freeBranch(root: string, name: string): Promise<string> {
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? name : `${name}-${n}`;
      if (!(await worktree.branchExists(root, candidate))) return candidate;
    }
  }

  /** Where the worktree's work began: its recorded base, or where it meets the checkout when none was recorded. */
  private async worktreeBase(thread: Thread, project: Project, head: string, other?: string): Promise<string> {
    if (thread.baseSha) return this.tree(project.rootPath, thread.baseSha);
    const common = other ? (await git(project.rootPath, ["merge-base", head, other])).stdout.trim() : head;
    return this.tree(project.rootPath, common);
  }

  private async head(cwd: string): Promise<string> {
    return (await git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  }

  private async tree(cwd: string, commit: string): Promise<string> {
    return (await git(cwd, ["rev-parse", "--verify", `${commit}^{tree}`])).stdout.trim();
  }
}

function entryChange(entry: { before: unknown; after: unknown }): "added" | "deleted" | "modified" {
  if (!entry.before) return "added";
  if (!entry.after) return "deleted";
  return "modified";
}
