import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { audit, orchestration, projects, runs, settings, tasks, teamRuntime, type Db } from "@openorc/db";
import { git, teamTransfer } from "@openorc/git";
import { TeamPublicationRecord, TeamTreeCapture, type TaskCheckoutPreview, type TaskCheckoutState } from "@openorc/protocol";
import { z } from "zod";
import { checkPublication, publishTeamFiles, type TeamFilePublicationHook } from "./team-file-publication.js";
import type { WorkspaceWriters } from "./workspace-writers.js";

const Receipt = z.object({
  id: z.string().uuid(),
  taskId: z.string(),
  source: TeamTreeCapture,
  baseSha: z.string(),
  destinationPath: z.string(),
  before: TeamTreeCapture,
  entries: TeamPublicationRecord.shape.entries,
  sourceBaseTree: z.string(),
  afterTree: z.string().nullable(),
  scratchPath: z.string(),
  state: z.enum(["ready", "conflict", "attention", "applied"]),
  patch: z.string(),
  conflicts: z.array(z.string()),
  error: z.string().nullable(),
});
type Receipt = z.infer<typeof Receipt>;
const key = (taskId: string) => `task.checkout.${taskId}`;
const same = (a: { oid: string; mode: string } | undefined, b: { oid: string; mode: string } | undefined) => a?.oid === b?.oid && a?.mode === b?.mode;

/** Ordinary task integration. Immutable deltas are journaled before any checkout write. */
export class TaskCheckoutService {
  constructor(
    private readonly db: Db,
    private readonly writers: WorkspaceWriters,
    private readonly dataDir: string,
    private readonly fault?: TeamFilePublicationHook,
  ) {}

  private context(taskId: string) {
    const task = tasks.get(this.db, taskId);
    const project = task && projects.get(this.db, task.projectId);
    if (!task || !project) throw new Error("Task or project no longer exists.");
    if ((task.threadId && orchestration.getInstance(this.db, task.threadId)) || teamRuntime.assignmentsForTask(this.db, taskId).length)
      throw new Error("Apply integrated team changes from the team conversation. This assignment cannot apply directly to the checkout.");
    if (task.workspaceMode !== "worktree" || !task.worktreePath || !task.baseSha) throw new Error("This task has no retained worktree to apply.");
    const history = runs.listForTask(this.db, taskId);
    if (history.some((run) => !run.endedAt) || (!history.at(-1)?.endedAt && !["review", "done"].includes(task.status))) throw new Error("Finish or stop the task’s agent before applying its changes.");
    return { task, project, sourcePath: task.worktreePath, baseSha: task.baseSha };
  }

  private read(taskId: string): Receipt | null {
    const raw = settings.get(this.db, key(taskId));
    return raw ? Receipt.parse(JSON.parse(raw)) : null;
  }
  private save(receipt: Receipt): void {
    settings.set(this.db, key(receipt.taskId), JSON.stringify(receipt));
  }
  private view(receipt: Receipt): TaskCheckoutPreview {
    return {
      id: receipt.id,
      sourcePath: receipt.source.rootPath,
      destinationPath: receipt.destinationPath,
      destinationBranch: receipt.before.branch?.replace(/^refs\/heads\//, "") ?? null,
      state: receipt.state,
      patch: receipt.patch,
      files: receipt.entries.length,
      conflicts: receipt.conflicts,
      scratchPath: receipt.scratchPath,
      error: receipt.error,
    };
  }

  async state(taskId: string): Promise<TaskCheckoutState> {
    const receipt = this.read(taskId);
    try {
      const context = this.context(taskId);
      const reason = await this.writers.reason([context.sourcePath, context.project.rootPath]);
      return { allowed: !reason, reason, preview: receipt ? this.view(receipt) : null };
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : String(error), preview: receipt ? this.view(receipt) : null };
    }
  }

  async prepare(taskId: string): Promise<TaskCheckoutPreview> {
    const context = this.context(taskId);
    return this.writers.withLease([context.sourcePath, context.project.rootPath], `preparing checkout application for task ${taskId}`, async () => {
      this.assertContext(taskId, context);
      const previous = this.read(taskId);
      if (previous?.state === "attention") throw new Error("Retry the retained application before preparing new changes. Its saved files and recovery evidence are still available.");
      await this.assertGitReady(context.sourcePath);
      await this.assertGitReady(context.project.rootPath);
      const id = randomUUID();
      const prefix = `refs/openorc/task-checkout/${taskId}/${id}`;
      const [source, before] = await Promise.all([
        teamTransfer.capture(context.sourcePath, { refPrefix: `${prefix}/source` }),
        teamTransfer.capture(context.project.rootPath, { refPrefix: `${prefix}/destination` }),
      ]);
      if (previous && (previous.source.rootPath !== source.rootPath || previous.destinationPath !== before.rootPath || previous.baseSha !== context.baseSha))
        throw new Error("The retained application belongs to a different task workspace or checkout. Restore that location before continuing.");
      // Subsequent applications carry only changes since the last applied source snapshot.
      // Retain this baseline through conflict previews too.
      const baseTree =
        previous?.state === "applied" ? previous.source.treeSha : (previous?.sourceBaseTree ?? (await git(context.sourcePath, ["rev-parse", `${context.baseSha}^{tree}`])).stdout.trim());
      const scratchPath = path.join(this.dataDir, "task-checkout", taskId, id);
      const merge = await teamTransfer.stageMerge(context.project.rootPath, {
        baseTree,
        outputTree: source.treeSha,
        destinationTree: before.treeSha,
        headSha: before.headSha,
        path: scratchPath,
        refPrefix: `${prefix}/merge`,
      });
      this.assertContext(taskId, context);
      const afterTree = merge.status === "clean" ? merge.treeSha : null;
      const [left, right] = await Promise.all([teamTransfer.listTree(context.project.rootPath, before.treeSha), teamTransfer.listTree(context.project.rootPath, afterTree ?? before.treeSha)]);
      const old = new Map(left.map((entry) => [entry.path, entry])),
        next = new Map(right.map((entry) => [entry.path, entry]));
      const entries = [...new Set([...old.keys(), ...next.keys()])]
        .filter((name) => !same(old.get(name), next.get(name)))
        .map((name) => ({ path: name, before: old.get(name) ?? null, after: next.get(name) ?? null }));
      const patch = afterTree ? (await git(context.project.rootPath, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-color", before.treeSha, afterTree])).stdout : "";
      const receipt: Receipt = {
        id,
        taskId,
        source,
        baseSha: context.baseSha,
        sourceBaseTree: baseTree,
        destinationPath: before.rootPath,
        before,
        entries,
        afterTree,
        scratchPath,
        patch,
        state: merge.status === "clean" ? "ready" : "conflict",
        conflicts: merge.status === "conflict" ? merge.conflicts : [],
        error: null,
      };
      this.save(receipt);
      return this.view(receipt);
    });
  }

  async apply(taskId: string, previewId: string): Promise<TaskCheckoutPreview> {
    const context = this.context(taskId);
    return this.writers.withLease([context.sourcePath, context.project.rootPath], `applying task ${taskId} to checkout`, async () => {
      const receipt = this.read(taskId);
      if (!receipt || receipt.id !== previewId) throw new Error("This preview was replaced. Review the latest checkout preview before applying.");
      if (receipt.state === "applied") return this.view(receipt);
      if (receipt.state === "conflict") throw new Error("Resolve the listed conflicts in the source worktree or checkout, then prepare a new preview. The checkout has not been changed.");
      this.assertContext(taskId, context);
      if (receipt.source.rootPath !== (await realpath(context.sourcePath)) || receipt.destinationPath !== (await realpath(context.project.rootPath)) || receipt.baseSha !== context.baseSha)
        throw new Error("The task or checkout location changed. Prepare a new preview.");
      if (receipt.state === "ready") {
        const current = await teamTransfer.capture(context.sourcePath, { refPrefix: `refs/openorc/task-checkout/${taskId}/verify-${randomUUID()}` });
        if (current.treeSha !== receipt.source.treeSha || current.headSha !== receipt.source.headSha) throw new Error("The source changed after preview. Prepare a new preview before applying.");
      }
      await this.assertGitReady(context.sourcePath);
      await this.assertGitReady(context.project.rootPath);
      await checkPublication(receipt);
      // Journal before publishing: a crash can replay exactly these writes, never a new merge over partial output.
      receipt.state = "attention";
      this.save(receipt);
      try {
        await publishTeamFiles(receipt, () => this.assertContext(taskId, context), this.fault);
        receipt.state = "applied";
        receipt.error = null;
        this.save(receipt);
        audit.record(this.db, {
          actor: "user",
          action: "review.applyCheckout",
          resourceType: "task",
          resourceId: taskId,
          metadata: { previewId, sourceTree: receipt.source.treeSha, files: receipt.entries.length },
        });
      } catch (error) {
        receipt.error = `${error instanceof Error ? error.message : String(error)} The saved application can be retried; source and preview remain at ${receipt.scratchPath}.`;
        this.save(receipt);
      }
      return this.view(receipt);
    });
  }

  private async assertGitReady(cwd: string): Promise<void> {
    if ((await git(cwd, ["ls-files", "--unmerged"])).stdout.trim()) throw new Error(`Resolve Git index conflicts in ${cwd} before applying task changes.`);
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "index.lock"]) {
      const file = (await git(cwd, ["rev-parse", "--git-path", name])).stdout.trim();
      const present = await lstat(path.resolve(cwd, file)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (present) throw new Error(`Finish the Git operation (${name}) in ${cwd} before applying task changes.`);
    }
  }

  private assertContext(taskId: string, expected: ReturnType<TaskCheckoutService["context"]>): void {
    const current = this.context(taskId);
    if (current.sourcePath !== expected.sourcePath || current.baseSha !== expected.baseSha || current.project.rootPath !== expected.project.rootPath)
      throw new Error("Task workspace changed during checkout application.");
  }
}
