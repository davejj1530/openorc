import { audit, orchestration, projects, runs as runRepo, snapshots, taskForwardings, tasks, teamDeletedThreads, teamRuntime, threads, threadQueue, type Db } from "@openorc/db";
import { WORKSPACE_ID, defaultHarnessId, type Project, type Run, type Task, type Thread, type ThreadSummary, type WorkspaceMode } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import type { RunScope, RunService, StartRunInput } from "./runs.js";
import type { WorkspaceService } from "./workspace.js";
import { executionProject } from "./workspace-home.js";
import { AppSettingsService } from "./settings.js";
import type { WorkspaceWriters } from "./workspace-writers.js";
import type { SpawnTaskInput, ThreadService } from "./threads.js";
import type { ThreadMessageQueue } from "./thread-message-queue.js";

type ContinueThreadInput = Parameters<ThreadService["continueThread"]>[1];

interface TaskThreadContext {
  get(id: string): ThreadSummary | null;
  executionThreadFor: ThreadService["executionThreadFor"];
  taskThreadForStart: ThreadService["taskThreadForStart"];
  continueThread(id: string, input: ContinueThreadInput): Promise<Run>;
  handoffBrief(thread: Thread, own: Run[]): string;
  rejectPinnedTeam(id: string | null): void;
}

/** Owns task assignment, start identity, workspace preparation, and return reports. */
export class ThreadTaskExecution {
  private readonly startingTaskThreads = new Map<string, { key: string; promise: Promise<Run> }>();
  private readonly startingTasks = new Map<string, { location: WorkspaceMode; promise: Promise<Task> }>();

  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly workspaces: WorkspaceService,
    private readonly invalidate: (keys: string[]) => void,
    private readonly log: Logger,
    private readonly writers: WorkspaceWriters,
    private readonly queue: Pick<ThreadMessageQueue, "hasTaskThreadReservation" | "reserveTaskThread" | "releaseTaskThread" | "deliver">,
    private readonly context: TaskThreadContext,
  ) {}

  private project(id: string): Project {
    const project = projects.get(this.db, id);
    if (!project) throw new Error(`project ${id} not found`);
    return project;
  }

  /* Tasks */

  /** A preference is editable only before a task owns or shares an execution workspace. */
  assertTaskWorkspaceEditable(task: Task): void {
    if (this.startingTaskThreads.has(task.id) || this.runs.liveRunForTask(task.id)) throw new Error("Wait for this task to stop before changing its execution location.");
    if (teamRuntime.assignmentForTask(this.db, task.id) || (task.threadId && orchestration.getInstance(this.db, task.threadId)))
      throw new Error("This task uses its saved team's workspace policy. Use the team workspace controls.");
    const assigned = task.executionThreadId ? this.context.executionThreadFor(task.id) : null;
    if (assigned?.archivedAt != null) throw new Error("Unarchive the execution conversation before changing its location.");
    if (assigned?.hasStarted || assigned?.worktreePath || task.worktreePath || runRepo.listForTask(this.db, task.id).length || taskForwardings.target(this.db, task.id))
      throw new Error("Move this task's thread to change its execution location.");
    if (task.projectId === WORKSPACE_ID) throw new Error("Workspace tasks use their conversation folder. Open a project to use a worktree.");
  }

  /** Saving an ordinary task never creates a conversation, agent, or workspace. */
  async spawnTask(thread: Thread, input: SpawnTaskInput, origin: "user" | "agent"): Promise<{ task: Task; duplicate: boolean; started: boolean }> {
    const project = executionProject(this.db, thread);
    const existing = tasks.findSimilarInThread(this.db, thread.id, input.title, input.spec);
    if (existing) return { task: existing, duplicate: true, started: false };
    const task = tasks.insert(this.db, {
      projectId: project.id,
      title: input.title.trim(),
      spec: input.spec.trim(),
      status: "backlog",
      priority: input.priority ?? "none",
      labels: [...new Set(input.labels ?? [])],
      workspaceMode: thread.projectId === WORKSPACE_ID ? "current" : (input.workspaceMode ?? thread.workspaceMode),
      baseRef: thread.worktreePath && thread.branch ? thread.branch : project.defaultBranch,
      parentTaskId: null,
      threadId: thread.id,
      origin,
    });
    audit.record(this.db, { actor: origin, action: "task.create", resourceType: "task", resourceId: task.id, metadata: { threadId: thread.id } });
    this.invalidate(["tasks", "inbox", "threads", `thread:${thread.id}`]);
    return { task, duplicate: false, started: false };
  }

  /** Reading execution ownership never assigns a thread or prepares files. */
  executionThreadFor(taskId: string): ThreadSummary | null {
    const task = tasks.get(this.db, taskId);
    if (!task) throw new Error("Task not found.");
    const executionId = task.executionThreadId ?? (task.threadId && orchestration.getInstance(this.db, task.threadId) ? task.threadId : null);
    if (!executionId) return null;
    const thread = this.context.get(executionId);
    if (!thread) throw new Error("This task's execution conversation was deleted. Its saved history is retained.");
    if (thread.projectId !== task.projectId) throw new Error("The task's execution conversation belongs to another project.");
    return thread;
  }

  /** Explicitly open/assign a conversation; the pure lookup above is used by views. */
  openTaskThread(taskId: string): Thread {
    return this.resolveTaskThread(taskId, undefined, false);
  }

  taskThreadForStart(taskId: string, selected?: Pick<Thread, "agent" | "model" | "effort">): Thread {
    return this.resolveTaskThread(taskId, selected, true);
  }

  private resolveTaskThread(taskId: string, selected: Pick<Thread, "agent" | "model" | "effort"> | undefined, starting: boolean): Thread {
    const task = tasks.get(this.db, taskId);
    if (!task) throw new Error("Task not found.");
    const assigned = this.context.executionThreadFor(taskId);
    if (assigned) return assigned;
    const handoff = taskForwardings.target(this.db, taskId);
    if (handoff?.state === "preparing") throw new Error("Finish this task’s saved handoff before opening its thread.");
    if (this.runs.liveRunForTask(taskId)) throw new Error("Stop the existing task agent in Activity before opening its conversation as a thread.");
    const previous = runRepo.listForTask(this.db, taskId).at(-1);
    const retainedWorkspace = Boolean(previous || task.worktreePath || handoff);
    const creator = task.threadId ? threads.get(this.db, task.threadId) : null;
    if (creator && teamDeletedThreads.has(this.db, creator.id)) throw new Error("This conversation was deleted. Its saved activity is available on the task.");
    const defaultPermissionMode = new AppSettingsService(this.db).get().defaultPermissionMode;
    const target = this.taskAgentSettings(selected, previous, creator);
    if (this.canReuseCreator(creator, task, target, starting, retainedWorkspace)) {
      this.invalidate(["tasks", `task:${taskId}`, "threads"]);
      return creator;
    }
    return this.createTaskThread({ task, previous, creator, target, starting, retainedWorkspace, handoff, defaultPermissionMode });
  }

  private taskAgentSettings(selected: Pick<Thread, "agent" | "model" | "effort"> | undefined, previous: Run | undefined, creator: Thread | null): Pick<Thread, "agent" | "model" | "effort"> {
    return (
      selected ?? {
        agent: previous?.agent ?? creator?.agent ?? defaultHarnessId,
        model: previous?.model ?? creator?.model ?? null,
        effort: previous?.effort ?? creator?.effort ?? null,
      }
    );
  }

  private canReuseCreator(creator: Thread | null, task: Task, target: Pick<Thread, "agent" | "model" | "effort">, starting: boolean, retainedWorkspace: boolean): creator is Thread {
    return Boolean(
      creator &&
      !retainedWorkspace &&
      creator.archivedAt === null &&
      (!starting || creator.mode === "act") &&
      creator.agent === target.agent &&
      creator.model === target.model &&
      creator.workspaceMode === task.workspaceMode &&
      this.runs.threadActivity(creator.id) === "idle" &&
      !this.queue.hasTaskThreadReservation(creator.id) &&
      !threadQueue.list(this.db, creator.id).length,
    );
  }

  private createTaskThread(input: {
    task: Task;
    previous: Run | undefined;
    creator: Thread | null;
    target: Pick<Thread, "agent" | "model" | "effort">;
    starting: boolean;
    retainedWorkspace: boolean;
    handoff: ReturnType<typeof taskForwardings.target>;
    defaultPermissionMode: Thread["permissionMode"];
  }): Thread {
    const { task, previous, creator, target, starting, retainedWorkspace, handoff, defaultPermissionMode } = input;
    let mode = creator?.mode ?? "act";
    if (retainedWorkspace) mode = previous?.mode ?? "act";
    if (starting) mode = "act";
    const thread = this.db.transaction(() => {
      const created = threads.insert(this.db, {
        projectId: task.projectId,
        title: task.title,
        ...target,
        fastMode: previous?.fastMode ?? creator?.fastMode ?? false,
        mode,
        permissionMode: previous?.permissionMode ?? creator?.permissionMode ?? defaultPermissionMode,
        workspaceMode: task.workspaceMode,
        // A handoff provides context across providers without resuming a parent's
        // active session or pretending its files were copied into this workspace.
        importedFrom: `task:${task.id}`,
        ...(retainedWorkspace ? { forkedFromId: creator?.id ?? null } : {}),
      });
      threads.update(this.db, created.id, {
        ...(task.projectId === WORKSPACE_ID ? { workingDirectory: creator?.workingDirectory ?? null } : {}),
        ...(retainedWorkspace ? { worktreePath: task.worktreePath, branch: task.branch, baseSha: task.baseSha } : {}),
        draft: this.taskThreadDraft(task, previous, creator, handoff),
      });
      tasks.update(this.db, task.id, { executionThreadId: created.id });
      audit.record(this.db, { actor: "user", action: "thread.create", resourceType: "thread", resourceId: created.id, metadata: { taskId: task.id, creatorThreadId: task.threadId } });
      return threads.get(this.db, created.id)!;
    });
    this.invalidate(["threads", "tasks", `task:${task.id}`, `thread:${thread.id}`]);
    return thread;
  }

  private taskThreadDraft(task: Task, previous: Run | undefined, creator: Thread | null, handoff: ReturnType<typeof taskForwardings.target>): string {
    return [
      handoff?.context ?? "",
      `Work on task "${task.title}" (${task.id}).\n\n${task.spec ?? ""}`,
      previous?.resultText ? `Previous task result:\n${previous.resultText}` : "",
      creator ? this.context.handoffBrief(creator, runRepo.listForThread(this.db, creator.id)) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Explicit UI execution goes through the conversation's normal session. */
  startTaskInThread(taskId: string, workspaceMode?: WorkspaceMode, images: string[] = [], input?: Parameters<ThreadService["continueThread"]>[1]): Promise<Run> {
    const key = JSON.stringify({ workspaceMode, images, input });
    const pending = this.startingTaskThreads.get(taskId);
    if (pending) return pending.key === key ? pending.promise : Promise.reject(new Error("This task is already starting with different settings."));
    const promise = this.launchTaskThread(taskId, workspaceMode, images, input).finally(() => this.startingTaskThreads.delete(taskId));
    this.startingTaskThreads.set(taskId, { key, promise });
    return promise;
  }

  private async launchTaskThread(taskId: string, workspaceMode: WorkspaceMode | undefined, images: string[], input?: Parameters<ThreadService["continueThread"]>[1]): Promise<Run> {
    const { task, thread } = this.prepareTaskThreadStart(taskId, workspaceMode, input);
    try {
      const run = await this.context.continueThread(thread.id, this.taskRunInput(task, thread, images, input));
      this.acceptTaskThreadStart(task, thread);
      return run;
    } finally {
      this.queue.releaseTaskThread(thread.id);
    }
  }

  private prepareTaskThreadStart(taskId: string, workspaceMode: WorkspaceMode | undefined, input?: ContinueThreadInput): { task: Task; thread: Thread } {
    const task = tasks.get(this.db, taskId);
    if (!task) throw new Error("Task not found.");
    this.assertTaskThreadStartAllowed(task, workspaceMode, input);
    const thread = this.context.taskThreadForStart(taskId, input ? { agent: input.agent, model: input.model ?? null, effort: input.effort ?? null } : undefined);
    if (workspaceMode && workspaceMode !== thread.workspaceMode) throw new Error("Move the thread to change its workspace before starting this task.");
    if (thread.archivedAt !== null) throw new Error("Unarchive this thread before starting work.");
    if (!input && thread.mode !== "act") throw new Error("Switch the thread to Act before starting this task.");
    this.queue.reserveTaskThread(thread.id);
    return { task, thread };
  }

  private assertTaskThreadStartAllowed(task: Task, workspaceMode: WorkspaceMode | undefined, input?: ContinueThreadInput): void {
    const taskId = task.id;
    this.context.rejectPinnedTeam(task.threadId);
    if (teamRuntime.assignmentForTask(this.db, taskId)) throw new Error("This task is managed by a saved team. Use its team execution controls.");
    if (this.runs.liveRunForTask(taskId)) throw new Error("Finish or stop this task's existing run before continuing in its thread.");
    if (task.status === "archived" || (task.status === "done" && !input)) throw new Error("Reopen this task before starting it.");
    const handoff = taskForwardings.target(this.db, taskId);
    if (handoff?.snapshot && workspaceMode && workspaceMode !== task.workspaceMode) throw new Error("This task already has forwarded files. Keep its handoff location.");
    if (!task.executionThreadId && workspaceMode) {
      if ((task.worktreePath || runRepo.listForTask(this.db, taskId).length) && workspaceMode !== task.workspaceMode)
        throw new Error("This task already has a workspace. Keep its existing execution location.");
      tasks.update(this.db, taskId, { workspaceMode });
    }
  }

  private taskRunInput(task: Task, thread: Thread, images: string[], input?: ContinueThreadInput): ContinueThreadInput {
    return {
      agent: thread.agent,
      model: thread.model ?? undefined,
      effort: thread.effort ?? undefined,
      fastMode: thread.fastMode,
      permissionMode: thread.permissionMode,
      mode: thread.mode,
      attachments: undefined,
      ...input,
      baseRef: task.baseRef ?? undefined,
      onCreated: (created) => {
        tasks.update(this.db, task.id, { executionThreadId: thread.id });
        audit.record(this.db, { actor: "user", action: "task.start", resourceType: "task", resourceId: task.id, metadata: { threadId: thread.id, runId: created.id } });
        input?.onCreated?.(created);
      },
      prompt: [
        input?.prompt ?? `Work on task "${task.title}" (${task.id}) in this conversation.`,
        `Task: ${task.title} (${task.id})\n\n${task.spec ?? ""}`,
        taskForwardings.target(this.db, task.id)?.context ?? "",
        thread.importedFrom === `task:${task.id}` ? (thread.draft ?? "") : "",
        images.length ? `Task images in document order (open them from these paths):\n${images.map((file, index) => `${index + 1}. ${file}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  private acceptTaskThreadStart(task: Task, thread: Thread): void {
    // A fast provider or another window may already have advanced the record.
    if (tasks.get(this.db, task.id)?.status === task.status) tasks.update(this.db, task.id, { status: "in_progress", completedAt: null }, { explicitStatus: true });
    if (thread.importedFrom === `task:${task.id}` && threads.get(this.db, thread.id)?.draft === thread.draft) threads.update(this.db, thread.id, { draft: null });
    this.invalidate(["tasks", `task:${task.id}`, "threads", `thread:${thread.id}`]);
  }

  /** Runs a task with its thread's agent, model, and permissions, seeded by the spec. */
  startTask(
    task: Task,
    execution?: Pick<Thread, "agent" | "model" | "effort" | "permissionMode"> & { fastMode?: boolean | undefined },
    workspaceMode?: WorkspaceMode,
    message?: Pick<StartRunInput, "prompt" | "attachments" | "mode">,
  ): Promise<Task> {
    task = tasks.get(this.db, task.id) ?? task;
    try {
      const handoff = taskForwardings.target(this.db, task.id);
      if (handoff?.state === "preparing") throw new Error("Finish this task’s saved handoff before starting an agent.");
      if (handoff?.snapshot && workspaceMode && workspaceMode !== task.workspaceMode) throw new Error("This task already has forwarded files. Keep its handoff location.");
      this.context.rejectPinnedTeam(task.threadId);
      if (teamRuntime.assignmentForTask(this.db, task.id)) throw new Error("This task is managed by a saved team. Use its team execution controls.");
    } catch (error) {
      return Promise.reject(error);
    }
    const location = workspaceMode ?? task.workspaceMode;
    const pending = this.startingTasks.get(task.id);
    if (pending) return pending.location === location ? pending.promise : Promise.reject(new Error("This task is already starting in another location."));
    const promise = this.launchTask(task, execution, location, message).finally(() => this.startingTasks.delete(task.id));
    this.startingTasks.set(task.id, { location, promise });
    return promise;
  }

  private async launchTask(
    task: Task,
    execution: (Pick<Thread, "agent" | "model" | "effort" | "permissionMode"> & { fastMode?: boolean | undefined }) | undefined,
    location: WorkspaceMode,
    message?: Pick<StartRunInput, "prompt" | "attachments" | "mode">,
  ): Promise<Task> {
    task = tasks.get(this.db, task.id) ?? task;
    const project = this.project(task.projectId);
    const thread = execution ?? (task.threadId ? threads.get(this.db, task.threadId) : null);
    if (this.runs.liveRunForTask(task.id)) {
      if (task.workspaceMode !== location) throw new Error("This task is already running in another location.");
      return task;
    }
    return this.writers.withLease(
      this.workspaces.taskPath({ ...task, workspaceMode: location }, project),
      `starting task ${task.id}`,
      async (workspaceLease) => {
        if (task.workspaceMode !== location) {
          if (task.worktreePath || runRepo.listForTask(this.db, task.id).length) throw new Error("This task already has a workspace or run history. Keep its existing execution location.");
          task = tasks.update(this.db, task.id, { workspaceMode: location, baseSha: null, branch: null });
        }
        const prepared = await this.workspaces.prepare(task, project, workspaceLease);
        await this.runs.start({
          scope: { task: prepared, thread: null },
          project,
          agent: thread?.agent ?? defaultHarnessId,
          model: thread?.model ?? undefined,
          effort: thread?.effort ?? undefined,
          fastMode: thread?.fastMode ?? false,
          mode: message?.mode ?? "act",
          permissionMode: thread?.permissionMode ?? "trusted",
          prompt: message?.prompt ?? [`Task: ${prepared.title}`, "", prepared.spec ?? ""].join("\n").trim(),
          attachments: message?.attachments,
          resume: false,
          workspaceLease,
        });
        this.invalidate(["tasks", "inbox", `task:${task.id}`, ...(task.threadId ? ["threads", `thread:${task.threadId}`] : [])]);
        return tasks.get(this.db, task.id) ?? prepared;
      },
      undefined,
      { shared: true },
    );
  }

  /**
   * A finished task run reports back to its thread. In act mode the thread's
   * agent gets the result as a system turn so it can chain the next step; in
   * plan mode the result waits in the thread for the user.
   */
  async onTaskRunFinished(run: Run, task: Task): Promise<void> {
    if (!task.threadId) return;
    const thread = threads.get(this.db, task.threadId);
    if (!thread) return;
    threads.touch(this.db, thread.id);
    this.invalidate(["threads", `thread:${thread.id}`, "tasks"]);
    const report = this.taskReport(run, task);
    if (!this.runs.postThreadNotice(thread.id, `task-report-${run.id}`, report)) return;
    if (thread.mode !== "act" || thread.archivedAt) return;
    try {
      await this.queue.deliver(thread, `${report}\n\nTask id: ${task.id}. Report the outcome to the user. Start further work only if their request calls for it.`, "system", [], false);
    } catch (e) {
      this.log.warn(`could not report task ${task.id} to thread ${thread.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private taskReport(run: Run, task: Task): string {
    const fresh = tasks.get(this.db, task.id) ?? task;
    const snap = snapshots.latestForTask(this.db, task.id);
    const changes = snap
      ? `${snap.diffStat.files + snap.diffStat.untracked} file(s), +${snap.diffStat.insertions} -${snap.diffStat.deletions}${snap.diffStat.untracked ? `, ${snap.diffStat.untracked} new` : ""}`
      : "no file changes recorded";
    const result = (run.resultText ?? run.error ?? "").trim();
    let outcome = "failed";
    if (run.state === "success") outcome = "finished";
    else if (run.state === "cancelled") outcome = "stopped";
    const lines = [`${fresh.title} — ${outcome}.`, "", `Changes: ${changes}.${fresh.branch ? ` Branch: ${fresh.branch}.` : ""}`];
    if (result) lines.push("", "Agent's final message:", result.length > 2000 ? `${result.slice(0, 2000)}…` : result);
    return lines.join("\n");
  }

  scopeThreadFor(scope: RunScope): Thread | null {
    if (scope.thread) return scope.thread;
    if (scope.comment) return null;
    return scope.task.executionThreadId ? threads.get(this.db, scope.task.executionThreadId) : null;
  }
}
