import { randomUUID } from "node:crypto";
import { access, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { checkpoints, threads, type Db } from "@openorc/db";
import { diffStat, fetchPullRequest, git, pinObject, pullRequestSource, treeHash, worktree } from "@openorc/git";
import type { Project, PullRequestDetail, Thread } from "@openorc/protocol";
import { checkpointRefs } from "./checkpoint-refs.js";
import type { WorkspaceWriters } from "./workspace-writers.js";
import { slugify } from "./workspace.js";

/**
 * Brings a pull request's head and base into the repository and returns their
 * merge base: where the pull request's changes start, as GitHub diffs them.
 */
export async function fetchPullRequestHead(project: Project, detail: PullRequestDetail): Promise<string> {
  const source = await pullRequestSource(project.rootPath, detail.url);
  await fetchPullRequest(project.rootPath, { source, number: detail.number, baseRefName: detail.baseRefName, commits: [detail.headSha, detail.baseSha] });
  return (await git(project.rootPath, ["merge-base", detail.baseSha, detail.headSha])).stdout.trim();
}

/** A worktree of its own at the pull request's head, detached, beside the app's other worktrees. */
export async function addReviewCheckout(dataDir: string, project: Project, detail: PullRequestDetail): Promise<string> {
  const target = path.join(dataDir, "worktrees", `${slugify(project.name)}-${project.id.slice(0, 6)}`, `pr-${detail.number}-${randomUUID().slice(0, 6)}`);
  await mkdir(path.dirname(target), { recursive: true });
  await worktree.addDetached(project.rootPath, { path: target, commit: detail.headSha });
  return target;
}

/**
 * Moves a review conversation's copy to the pull request's new head for another
 * round. What the last round left in the copy while testing is dropped: none of
 * it belongs to the pull request, and each turn's checkpoint still holds it.
 * The new code is saved as a labelled checkpoint, which the next turn's changes
 * count from: otherwise the agent would be credited with the pull request's new
 * commits.
 */
export async function moveReviewCheckout(deps: { db: Db; writers: Pick<WorkspaceWriters, "withLease"> }, project: Project, thread: Thread, detail: PullRequestDetail): Promise<void> {
  const cwd = thread.worktreePath!;
  await deps.writers.withLease(cwd, `reviewing pull request #${detail.number} again`, async () => {
    const present = await access(cwd).then(
      () => true,
      () => false,
    );
    if (!present) {
      await worktree.prune(project.rootPath);
      await worktree.addDetached(project.rootPath, { path: cwd, commit: detail.headSha });
    } else {
      await worktree.checkoutDetached(cwd, detail.headSha, { discard: true });
    }
    const tree = await treeHash(cwd);
    await pinObject(cwd, `${checkpointRefs(thread.id)}${tree}`, tree);
    const turn = checkpoints.listForThread(deps.db, thread.id).at(-1)?.turn ?? 0;
    const note = `Pull request #${detail.number} at ${detail.headSha.slice(0, 7)}`;
    checkpoints.insert(deps.db, { threadId: thread.id, runId: null, turn, treeSha: tree, diffStat: await diffStat(cwd, detail.headSha), note, root: await realpath(cwd) });
    threads.update(deps.db, thread.id, { baseSha: detail.headSha, prUrl: detail.url, prState: detail.state });
  });
}
