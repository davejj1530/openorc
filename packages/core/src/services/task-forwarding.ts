import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { audit, projects, runs, taskForwardings, tasks, threads, type Db } from "@openorc/db";
import { git, teamTransfer } from "@openorc/git";
import type { Task, TaskForwarding, TaskForwardingState, WorkspaceMode } from "@openorc/protocol";
import type { TeamTaskService } from "./team-tasks.js";
import type { TeamOperationGuard } from "./team-operations.js";
import type { WorkspaceWriters } from "./workspace-writers.js";
import type { TaskCheckoutService } from "./task-checkout.js";

/** Forwarding is a retained handoff, never a second writer in a team's workspace. */
export class TaskForwardingService {
  private readonly pending = new Map<string, Promise<Task>>();
  private closing = false;
  constructor(
    private readonly db: Db,
    private readonly teamTasks: TeamTaskService,
    private readonly guard: TeamOperationGuard,
    private readonly writers: WorkspaceWriters,
    private readonly checkout: TaskCheckoutService,
    private readonly dataDir: string,
    private readonly defaultWorkspace: () => WorkspaceMode,
    private readonly changed: (keys: string[]) => void,
  ) {}

  state(taskId: string): TaskForwardingState {
    const forwarding = taskForwardings.source(this.db, taskId) ?? taskForwardings.target(this.db, taskId);
    const workspaceMode = forwarding?.workspaceMode ?? this.defaultWorkspace();
    try {
      if (this.closing) throw new Error("Task forwarding is shutting down.");
      if (forwarding?.state === "ready") return { allowed: false, reason: null, workspaceMode, forwarding };
      if (forwarding?.targetTaskId === taskId) throw new Error("Finish the saved handoff from the original team task before starting this agent.");
      const task = tasks.get(this.db, taskId);
      const team = this.teamTasks.state(taskId);
      if (!task || !team) throw new Error("Only team tasks need to be forwarded. Choose a model in this task’s Agent tab.");
      if (team.working) throw new Error("Finish or stop this task’s current team assignment before forwarding it.");
      if (runs.listForTask(this.db, taskId).some((run) => !run.endedAt)) throw new Error("Wait for this task’s agent to finish closing before forwarding it.");
      const historical = team.assignments.length > 0 || team.admissions.length > 0;
      if (historical) {
        const reason = this.guard.reason(team.threadId, taskId, { retainedTask: true });
        if (reason) throw new Error(reason);
      } else this.guard.assertAvailable(team.threadId, taskId, { retainedTask: true });
      return { allowed: true, reason: null, workspaceMode, forwarding };
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : String(error), workspaceMode, forwarding };
    }
  }

  forward(taskId: string, workspaceMode: WorkspaceMode): Promise<Task> {
    const pending = this.pending.get(taskId);
    if (pending)
      return pending.then((task) => {
        if (taskForwardings.source(this.db, taskId)?.workspaceMode !== workspaceMode) throw new Error("A handoff to another workspace is already saved. Finish that handoff first.");
        return task;
      });
    const operation = this.perform(taskId, workspaceMode).finally(() => this.pending.delete(taskId));
    this.pending.set(taskId, operation);
    return operation;
  }

  private async perform(taskId: string, workspaceMode: WorkspaceMode): Promise<Task> {
    if (this.closing) throw new Error("Task forwarding is shutting down.");
    let record = taskForwardings.source(this.db, taskId);
    if (record && record.workspaceMode !== workspaceMode) throw new Error("This task already has a saved handoff to another workspace. Retry its original location.");
    if (record?.state === "ready") return this.target(record);
    const availability = this.state(taskId);
    if (!availability.allowed) throw new Error(availability.reason!);
    const source = tasks.get(this.db, taskId)!;
    const team = this.teamTasks.state(taskId)!;
    const project = projects.get(this.db, source.projectId)!;
    const thread = threads.get(this.db, team.threadId)!;
    const historical = team.assignments.length > 0 || team.admissions.length > 0;
    const reservation = historical ? this.guard.reserve(thread.id, taskId, { retainedTask: true }) : null;
    const sourcePath = source.worktreePath ?? thread.worktreePath ?? project.rootPath;
    try {
      if (!record) {
        // Capture before any new task is visible. Existing source files are read only.
        const snapshot = historical
          ? await this.writers.withLease(sourcePath, `forward task ${taskId}`, async () => {
              reservation!.assertCurrent();
              return teamTransfer.capture(sourcePath, { refPrefix: `refs/openorc/task-forward/${taskId}/${randomUUID()}` });
            })
          : null;
        reservation?.assertCurrent();
        const context = [
          `Forwarded from team ${team.teamName}. Source task: ${taskId}.`,
          "The original task and team transcript are retained as history. This is an independent task; do not use the former team’s assignment or completion tools.",
          ...team.assignments.flatMap((item) => (item.result ? [`Previous result (${item.memberKey}):\n${item.result}`] : [])),
          ...team.admissions.flatMap((item) => (item.result || item.error ? [`Previous request (${item.state}):\n${item.result ?? item.error}`] : [])),
        ]
          .join("\n\n")
          .slice(0, 100_000);
        record = this.db.transaction(() => {
          if (this.teamTasks.working(taskId)) throw new Error("This task started working before the handoff. Finish or stop it first.");
          const latest = tasks.get(this.db, taskId);
          if (!latest) throw new Error("The original task no longer exists.");
          const target = tasks.insert(this.db, {
            projectId: project.id,
            threadId: null,
            parentTaskId: null,
            title: latest.title,
            spec: latest.spec,
            priority: latest.priority,
            labels: latest.labels,
            workspaceMode: snapshot ? "worktree" : workspaceMode,
            baseRef: source.baseSha ?? thread.baseSha ?? snapshot?.headSha ?? null,
            origin: "user",
          });
          const saved: TaskForwarding = {
            sourceTaskId: taskId,
            targetTaskId: target.id,
            sourceThreadId: thread.id,
            workspaceMode,
            state: "preparing",
            context,
            snapshot,
            baseSha: source.baseSha ?? thread.baseSha ?? snapshot?.headSha ?? null,
            stagingPath: null,
            previewId: null,
            error: null,
            createdAt: Date.now(),
          };
          taskForwardings.save(this.db, saved);
          return saved;
        });
      }
      if (record.snapshot) {
        if (!record.stagingPath) {
          record.stagingPath = path.join(this.dataDir, "task-forwardings", record.targetTaskId, randomUUID());
          taskForwardings.save(this.db, record);
        }
        const staging = record.stagingPath;
        const exists = await access(staging).then(
          () => true,
          () => false,
        );
        const current = this.target(record);
        if (!exists || current.worktreePath !== staging) {
          // A partial materialization is never used as input; retry in a fresh directory.
          if (exists) {
            record.stagingPath = path.join(this.dataDir, "task-forwardings", record.targetTaskId, randomUUID());
            taskForwardings.save(this.db, record);
          }
          const destination = record.stagingPath!;
          await this.writers.withLease(destination, `prepare forwarded task ${record.targetTaskId}`, async () => {
            reservation!.assertCurrent();
            await teamTransfer.materialize(project.rootPath, { snapshot: record!.snapshot!, path: destination });
            const branch = `openorc/forward-${record!.targetTaskId}-${path.basename(destination).slice(0, 8)}`;
            await git(destination, ["checkout", "-b", branch]);
            tasks.update(this.db, record!.targetTaskId, { workspaceMode: "worktree", worktreePath: destination, branch, baseSha: record!.baseSha, baseRef: record!.baseSha, status: "review" });
          });
        }
        if (workspaceMode === "current") {
          const state = await this.checkout.state(record.targetTaskId);
          // Conflicts can be reconciled in the retained copy or checkout before retry.
          const preview = state.preview && ["attention", "applied"].includes(state.preview.state) ? state.preview : await this.checkout.prepare(record.targetTaskId);
          record.previewId = preview.id;
          taskForwardings.save(this.db, record);
          const applied = await this.checkout.apply(record.targetTaskId, preview.id);
          if (applied.state !== "applied") throw new Error("The checkout handoff needs recovery before starting an agent.");
        }
      }
      reservation?.assertCurrent();
      const ready = record;
      this.db.transaction(() => {
        if (workspaceMode === "current") tasks.update(this.db, ready.targetTaskId, { workspaceMode: "current", worktreePath: null, branch: null, baseSha: null, baseRef: null });
        tasks.update(this.db, ready.targetTaskId, { status: "backlog" });
        // Archiving the old document does not invoke workspace cleanup: its history and files stay intact.
        tasks.update(this.db, taskId, { status: "archived" });
        taskForwardings.save(this.db, { ...ready, state: "ready", error: null });
        audit.record(this.db, { actor: "user", action: "task.forward", resourceType: "task", resourceId: taskId, metadata: { targetTaskId: ready.targetTaskId, workspaceMode } });
      });
      return this.target(record);
    } catch (error) {
      if (record) taskForwardings.save(this.db, { ...record, error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      reservation?.release();
      // A forward into the checkout may have written files even when it failed partway.
      this.changed([...(workspaceMode === "current" ? ["workspace-diff"] : []), "tasks", "orchestration", `task:${taskId}`, ...(record ? [`task:${record.targetTaskId}`] : [])]);
    }
  }

  private target(record: TaskForwarding): Task {
    const task = tasks.get(this.db, record.targetTaskId);
    if (!task) throw new Error("The forwarded task was deleted. Its original team history is still retained.");
    return task;
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.pending.values());
  }
}
