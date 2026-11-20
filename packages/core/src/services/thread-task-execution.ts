import { audit, projects, retiredTeams, runs as runRepo, snapshots, taskThreads, tasks, threadQueue, threads, type Db } from "@openorc/db";
import {
  ExecutionMode,
  WORKSPACE_ID,
  defaultHarnessId,
  executionModeSettings,
  skillPrompt,
  type Project,
  type Run,
  type Task,
  type TaskButton,
  type TaskThreadLink,
  type Thread,
  type ThreadChoice,
  type ThreadSummary,
  type WorkspaceMode,
} from "@openorc/protocol";
import type { Logger } from "../transport.js";
import type { RunScope, RunService, StartRunInput } from "./runs.js";
import { AppSettingsService } from "./settings.js";
import type { ThreadMessageQueue } from "./thread-message-queue.js";
import type { SpawnTaskInput, ThreadService } from "./threads.js";
import { executionProject } from "./workspace-home.js";
import type { WorkspaceWriters } from "./workspace-writers.js";
import type { WorkspaceService } from "./workspace.js";
import { startingAccount } from "./project-claude-accounts.js";

type ContinueThreadInput = Parameters<ThreadService["continueThread"]>[1];

/**
 * How a task thread this makes starts beyond its model: an account already settled (the starter's own, or one a person
 * chose), and with a person's choice the fast mode it keeps and what a creator thread must have to be reused instead.
 */
type ThreadStart = { account: string | undefined; fastMode?: boolean; choice?: ThreadChoice };

/** What picks a task's thread: a person's choice of model and account, or a starter's model and its own account. */
type ThreadPick = { choice?: ThreadChoice | undefined; selected?: Pick<Thread, "agent" | "model" | "effort"> | undefined; ownAccount?: string | undefined };

interface TaskThreadContext {
  get(id: string): ThreadSummary | null;
  executionThreadFor: ThreadService["executionThreadFor"];
  taskThreadForStart: ThreadService["taskThreadForStart"];
  continueThread(id: string, input: ContinueThreadInput): Promise<Run>;
  handoffBrief(thread: Thread, own: Run[]): string;
  rejectRetiredThread(id: string | null): void;
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
    if (retiredTeams.hasTask(this.db, task.id) || (task.threadId && retiredTeams.isHidden(this.db, task.threadId))) throw new Error("This item is no longer available.");
    const assigned = task.executionThreadId ? this.context.executionThreadFor(task.id) : null;
    if (assigned?.archivedAt != null) throw new Error("Reopen the execution conversation before changing its location.");
    if (assigned?.hasStarted || assigned?.worktreePath || task.worktreePath || runRepo.listForTask(this.db, task.id).length)
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
    if (task.retiredTeam) return null;
    const executionId = task.executionThreadId;
    if (!executionId) return null;
    const thread = this.context.get(executionId);
    if (!thread) throw new Error("This task's execution conversation was deleted. Its saved history is retained.");
    if (thread.projectId !== task.projectId) throw new Error("The task's execution conversation belongs to another project.");
    return thread;
  }

  /**
   * Explicitly open/assign a conversation; the pure lookup above is used by views. A choice of model and account applies
   * only to a thread this creates: a task that has its thread opens it as it is.
   */
  openTaskThread(taskId: string, choice?: ThreadChoice): Thread {
    return this.resolveTaskThread(taskId, false, { choice });
  }

  /** `ownAccount` is the starter's own Claude account, as an Orcling's, which the project's accounts leave alone. */
  taskThreadForStart(taskId: string, selected?: Pick<Thread, "agent" | "model" | "effort">, ownAccount?: string): Thread {
    return this.resolveTaskThread(taskId, true, { selected, ownAccount });
  }

  private resolveTaskThread(taskId: string, starting: boolean, { choice, selected = choice, ownAccount }: ThreadPick): Thread {
    const task = tasks.get(this.db, taskId);
    if (!task) throw new Error("Task not found.");
    if (retiredTeams.hasTask(this.db, taskId)) throw new Error("This item is no longer available.");
    const assigned = this.context.executionThreadFor(taskId);
    if (assigned) return assigned;
    if (this.runs.liveRunForTask(taskId)) throw new Error("Stop the existing task agent in Activity before opening its conversation as a thread.");
    const previous = runRepo.listForTask(this.db, taskId).at(-1);
    const retainedWorkspace = Boolean(previous || task.worktreePath);
    const creator = task.threadId ? threads.get(this.db, task.threadId) : null;
    if (creator && retiredTeams.isDeleted(this.db, creator.id)) throw new Error("This conversation was deleted. Its saved activity is available on the task.");
    const target = this.taskAgentSettings(selected, previous, creator);
    const inherited = this.firstThreadSettings(previous, creator);
    const start: ThreadStart = choice ? { choice, account: chosenAccount(this.db, task.projectId, choice), fastMode: keptFastMode(inherited, choice) } : { account: ownAccount };
    if (this.canReuseCreator(creator, task, target, starting, retainedWorkspace, start)) {
      this.invalidate(["tasks", `task:${taskId}`, "threads"]);
      return creator;
    }
    return this.createTaskThread({ task, previous, creator, target, starting, retainedWorkspace, inherited, ...start });
  }

  /** The agent the person chose to start new threads with, else the first one OpenOrc lists. */
  private defaultAgent(): Thread["agent"] {
    return new AppSettingsService(this.db).get().defaultHarness ?? defaultHarnessId;
  }

  private taskAgentSettings(selected: Pick<Thread, "agent" | "model" | "effort"> | undefined, previous: Run | undefined, creator: Thread | null): Pick<Thread, "agent" | "model" | "effort"> {
    if (selected) return { agent: selected.agent, model: selected.model, effort: selected.effort };
    return {
      agent: previous?.agent ?? creator?.agent ?? this.defaultAgent(),
      model: previous?.model ?? creator?.model ?? null,
      effort: previous?.effort ?? creator?.effort ?? null,
    };
  }

  private firstThreadSettings(previous: Run | undefined, creator: Thread | null): FirstThreadSettings {
    return {
      ...this.taskAgentSettings(undefined, previous, creator),
      claudeAccountId: previous?.claudeAccountId ?? creator?.claudeAccountId ?? null,
      fastMode: previous?.fastMode ?? creator?.fastMode ?? false,
      permissionMode: previous?.permissionMode ?? creator?.permissionMode ?? new AppSettingsService(this.db).get().defaultPermissionMode,
    };
  }

  private canReuseCreator(
    creator: Thread | null,
    task: Task,
    target: Pick<Thread, "agent" | "model" | "effort">,
    starting: boolean,
    retainedWorkspace: boolean,
    start: ThreadStart,
  ): creator is Thread {
    return Boolean(
      creator &&
      (!start.choice || sameEffortAndAccount(creator, start.choice, start.account)) &&
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

  private createTaskThread(
    input: {
      task: Task;
      previous: Run | undefined;
      creator: Thread | null;
      target: Pick<Thread, "agent" | "model" | "effort">;
      starting: boolean;
      retainedWorkspace: boolean;
      inherited: FirstThreadSettings;
    } & ThreadStart,
  ): Thread {
    const { task, previous, creator, target, starting, retainedWorkspace, inherited, account, fastMode } = input;
    let mode = creator?.mode ?? "act";
    if (retainedWorkspace) mode = previous?.mode ?? "act";
    if (starting) mode = "act";
    const thread = this.db.transaction(() => {
      const created = threads.insert(this.db, {
        projectId: task.projectId,
        title: task.title,
        ...target,
        // The starter's own or a chosen one, or the account it ran on, or its creator's, unless the project no longer uses that.
        claudeAccountId: account ?? inheritedAccount(this.db, task.projectId, target.agent, inherited.claudeAccountId),
        fastMode: fastMode ?? inherited.fastMode,
        mode,
        permissionMode: inherited.permissionMode,
        workspaceMode: task.workspaceMode,
        // A handoff provides context across providers without resuming a parent's
        // active session or pretending its files were copied into this workspace.
        importedFrom: `task:${task.id}`,
        ...(retainedWorkspace ? { forkedFromId: creator?.id ?? null } : {}),
      });
      threads.update(this.db, created.id, {
        ...(task.projectId === WORKSPACE_ID ? { workingDirectory: creator?.workingDirectory ?? null } : {}),
        ...(retainedWorkspace ? { worktreePath: task.worktreePath, branch: task.branch, baseSha: task.baseSha } : {}),
        draft: this.taskThreadDraft(task, previous, creator),
      });
      tasks.update(this.db, task.id, { executionThreadId: created.id });
      audit.record(this.db, { actor: "user", action: "thread.create", resourceType: "thread", resourceId: created.id, metadata: { taskId: task.id, creatorThreadId: task.threadId } });
      return threads.get(this.db, created.id)!;
    });
    this.invalidate(["threads", "tasks", `task:${task.id}`, `thread:${thread.id}`]);
    return thread;
  }

  private taskThreadDraft(task: Task, previous: Run | undefined, creator: Thread | null): string {
    return [
      `Work on task "${task.title}" (${task.id}).\n\n${task.spec ?? ""}`,
      previous?.resultText ? `Previous task result:\n${previous.resultText}` : "",
      creator ? this.context.handoffBrief(creator, runRepo.listForThread(this.db, creator.id)) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /**
   * Explicit UI execution goes through the conversation's normal session. `withTask` false sends the prompt alone,
   * without the task after it, as a button set not to include it does.
   */
  startTaskInThread(taskId: string, workspaceMode?: WorkspaceMode, images: string[] = [], input?: Parameters<ThreadService["continueThread"]>[1], withTask = true): Promise<Run> {
    const key = JSON.stringify({ workspaceMode, images, input, withTask });
    const pending = this.startingTaskThreads.get(taskId);
    if (pending) return pending.key === key ? pending.promise : Promise.reject(new Error("This task is already starting with different settings."));
    const promise = this.launchTaskThread(taskId, workspaceMode, images, input, withTask).finally(() => this.startingTaskThreads.delete(taskId));
    this.startingTaskThreads.set(taskId, { key, promise });
    return promise;
  }

  private async launchTaskThread(
    taskId: string,
    workspaceMode: WorkspaceMode | undefined,
    images: string[],
    input: Parameters<ThreadService["continueThread"]>[1] | undefined,
    withTask: boolean,
  ): Promise<Run> {
    const { task, thread } = this.prepareTaskThreadStart(taskId, workspaceMode, input);
    try {
      const run = await this.context.continueThread(thread.id, this.taskRunInput(task, thread, images, input, withTask));
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
    if (thread.archivedAt !== null) threads.reopen(this.db, thread.id);
    if (!input && thread.mode !== "act") throw new Error("Switch the thread to Act before starting this task.");
    this.queue.reserveTaskThread(thread.id);
    return { task, thread };
  }

  private assertTaskThreadStartAllowed(task: Task, workspaceMode: WorkspaceMode | undefined, input?: ContinueThreadInput): void {
    const taskId = task.id;
    this.context.rejectRetiredThread(task.threadId);
    if (retiredTeams.hasTask(this.db, taskId)) throw new Error("This item is no longer available.");
    if (this.runs.liveRunForTask(taskId)) throw new Error("Finish or stop this task's existing run before continuing in its thread.");
    if (task.status === "archived" || (task.status === "done" && !input)) throw new Error("Reopen this task before starting it.");
    if (!task.executionThreadId && workspaceMode) {
      if ((task.worktreePath || runRepo.listForTask(this.db, taskId).length) && workspaceMode !== task.workspaceMode)
        throw new Error("This task already has a workspace. Keep its existing execution location.");
      tasks.update(this.db, taskId, { workspaceMode });
    }
  }

  private taskRunInput(task: Task, thread: Thread, images: string[], input: ContinueThreadInput | undefined, withTask = true): ContinueThreadInput {
    const lead = input?.prompt ?? `Work on task "${task.title}" (${task.id}) in this conversation.`;
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
      prompt: withTask ? taskPrompt(lead, task, images, thread.importedFrom === `task:${task.id}` ? (thread.draft ?? "") : "") : lead,
    };
  }

  /* A task's threads */

  /** Every thread the task has had: the current one first, then earlier work and its buttons' threads, newest first. */
  taskThreadList(taskId: string): TaskThreadLink[] {
    const task = tasks.get(this.db, taskId);
    if (!task) throw new Error("Task not found.");
    const linked = taskThreads.list(this.db, taskId);
    const rows = task.executionThreadId && !linked.some((link) => link.threadId === task.executionThreadId) ? [{ threadId: task.executionThreadId, label: null }, ...linked] : linked;
    return rows
      .flatMap((link) => {
        const thread = this.context.get(link.threadId);
        return thread && !retiredTeams.isHidden(this.db, thread.id) ? [{ thread, label: link.label, current: thread.id === task.executionThreadId }] : [];
      })
      .sort((a, b) => Number(b.current) - Number(a.current));
  }

  /**
   * A fresh working thread for the task, in the same checkout, starting a new session from the task and a brief of the
   * last thread instead of resuming its history. The last thread stays listed with the task.
   */
  newTaskThread(taskId: string, choice?: ThreadChoice): Thread {
    const task = tasks.get(this.db, taskId);
    if (!task) throw new Error("Task not found.");
    if (retiredTeams.hasTask(this.db, taskId)) throw new Error("This item is no longer available.");
    const previous = this.context.executionThreadFor(taskId);
    if (!previous?.hasStarted) return this.openTaskThread(taskId, choice);
    if (this.startingTaskThreads.has(taskId) || this.runs.liveRunForTask(taskId) || this.runs.threadActivity(previous.id) !== "idle")
      throw new Error("Wait for the task's thread to finish before starting a new one.");
    const settings = followingSettings(this.db, task.projectId, previous, choice);
    const thread = this.db.transaction(() => {
      const created = threads.insert(this.db, {
        projectId: task.projectId,
        title: task.title,
        ...settings,
        mode: previous.mode,
        permissionMode: previous.permissionMode,
        workspaceMode: previous.workspaceMode,
        importedFrom: `task:${task.id}`,
      });
      threads.update(this.db, created.id, {
        ...(task.projectId === WORKSPACE_ID ? { workingDirectory: previous.workingDirectory } : {}),
        ...this.sharedWorktree(previous, task.projectId),
        draft: this.taskThreadDraft(task, undefined, previous),
      });
      taskThreads.link(this.db, { taskId: task.id, threadId: previous.id, label: null });
      taskThreads.link(this.db, { taskId: task.id, threadId: created.id, label: null });
      tasks.update(this.db, task.id, { executionThreadId: created.id });
      audit.record(this.db, { actor: "user", action: "thread.create", resourceType: "thread", resourceId: created.id, metadata: { taskId: task.id, previousThreadId: previous.id } });
      return threads.get(this.db, created.id)!;
    });
    this.invalidate(["threads", "tasks", `task:${task.id}`, `thread:${thread.id}`]);
    return thread;
  }

  async runTaskButton(taskId: string, button: TaskButton, images: string[]): Promise<{ threadId: string; draft?: string }> {
    const task = tasks.get(this.db, taskId);
    if (!task) throw new Error("Task not found.");
    this.context.rejectRetiredThread(task.threadId);
    if (retiredTeams.hasTask(this.db, taskId)) throw new Error("This item is no longer available.");
    const work = this.context.executionThreadFor(taskId);
    const creator = task.threadId ? threads.get(this.db, task.threadId) : null;
    const inherited = work ?? this.firstThreadSettings(runRepo.listForTask(this.db, taskId).at(-1), creator);
    const settings = followingSettings(this.db, task.projectId, inherited, button.choice);
    const run = buttonRun(button, work?.mode, inherited.permissionMode);
    const prompt = skillPrompt(button.prompt, button.skills, settings.agent);
    const input = {
      agent: settings.agent,
      model: settings.model ?? undefined,
      effort: settings.effort ?? undefined,
      fastMode: settings.fastMode,
      permissionMode: run.permissionMode,
      mode: run.mode,
      attachments: undefined,
    };
    const message = button.includeTask === false ? prompt : taskPrompt(prompt, task, images);
    const draft = button.autoSend === false ? message : null;
    if (button.runsIn === "task") {
      // The thread keeps its account unless the button chose one.
      const account = button.choice?.claudeAccountId ? { claudeAccountId: settings.claudeAccountId } : {};
      if (draft) return this.draftInTaskThread(task, button, work, { ...input, ...account }, draft);
      return this.runInTaskThread(task, button, Boolean(work), images, { ...input, ...account, prompt });
    }
    const thread = this.buttonThread(task, button, { work, creator, settings, run, draft });
    if (draft) return { threadId: thread.id, draft };
    await this.context.continueThread(thread.id, { ...input, baseRef: task.baseRef ?? undefined, prompt: message });
    return { threadId: thread.id };
  }

  /**
   * Where a thread made from `from` works: in its worktree, on its branch. A branch can be checked out in one folder
   * only, so when cleanup removed the worktree, both threads point at the folder the first of them to run makes again.
   */
  private sharedWorktree(from: Thread | null, projectId: string) {
    if (from?.workspaceMode !== "worktree") return {};
    let worktreePath = from.worktreePath;
    if (!worktreePath && from.branch) {
      worktreePath = this.workspaces.threadPath(from, this.project(projectId));
      threads.update(this.db, from.id, { worktreePath });
    }
    return { worktreePath, branch: from.branch, baseSha: from.baseSha, baseBranch: from.baseBranch };
  }

  private buttonThread(
    task: Task,
    button: TaskButton,
    { work, creator, settings, run, draft }: { work: ThreadSummary | null; creator: Thread | null; settings: FollowingSettings; run: ReturnType<typeof buttonRun>; draft: string | null },
  ): Thread {
    const thread = this.db.transaction(() => {
      const created = threads.insert(this.db, {
        projectId: task.projectId,
        title: `${button.label}: ${task.title}`,
        ...settings,
        mode: run.mode,
        permissionMode: run.permissionMode,
        workspaceMode: work?.workspaceMode ?? task.workspaceMode,
      });
      // It works where the task's work is: the working thread's worktree, else the folder a new one would use.
      threads.update(this.db, created.id, {
        ...(task.projectId === WORKSPACE_ID ? { workingDirectory: work?.workingDirectory ?? creator?.workingDirectory ?? null } : {}),
        ...this.sharedWorktree(work, task.projectId),
        draft,
      });
      taskThreads.link(this.db, { taskId: task.id, threadId: created.id, label: button.label });
      audit.record(this.db, { actor: "user", action: "thread.create", resourceType: "thread", resourceId: created.id, metadata: { taskId: task.id, button: button.label } });
      return threads.get(this.db, created.id)!;
    });
    this.invalidate(["threads", `thread:${thread.id}`]);
    return thread;
  }

  /**
   * An idle thread takes the button's mode, and its model when the agent is the same. Another agent or account is left
   * to the message box's picker, since switching one hands the conversation over as the message is sent.
   */
  private draftInTaskThread(task: Task, button: TaskButton, work: ThreadSummary | null, settings: Omit<ContinueThreadInput, "prompt">, draft: string): { threadId: string; draft: string } {
    const thread = work ?? this.openTaskThread(task.id, button.choice);
    // A conversation the task came from keeps what its box holds, as the task's thread does.
    const existed = Boolean(work) || thread.id === task.threadId;
    const before = existed ? threads.get(this.db, thread.id)?.draft : null;
    const idle = this.runs.threadActivity(thread.id) === "idle";
    const model = settings.agent === thread.agent ? { model: settings.model ?? null, effort: settings.effort ?? null } : {};
    threads.update(this.db, thread.id, {
      ...(idle ? { mode: settings.mode, permissionMode: settings.permissionMode, ...model } : {}),
      draft: before ? `${before}\n\n${draft}` : draft,
    });
    this.invalidate(["threads", `thread:${thread.id}`, "tasks", `task:${task.id}`]);
    return { threadId: thread.id, draft };
  }

  /** A button that runs as Start does. A task without a thread starts one on the button's choice, so it is made on the chosen account. */
  private async runInTaskThread(task: Task, button: TaskButton, hasThread: boolean, images: string[], input: ContinueThreadInput): Promise<{ threadId: string }> {
    if (button.choice && !hasThread) {
      this.assertTaskThreadStartAllowed(task, undefined, input);
      this.resolveTaskThread(task.id, true, { choice: button.choice });
    }
    const withTask = button.includeTask !== false;
    const run = await this.startTaskInThread(task.id, undefined, withTask ? images : [], input, withTask);
    return { threadId: run.threadId! };
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
      this.context.rejectRetiredThread(task.threadId);
      if (retiredTeams.hasTask(this.db, task.id)) throw new Error("This item is no longer available.");
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
          agent: thread?.agent ?? this.defaultAgent(),
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
      await this.queue.deliver(thread, `${report}\n\nTask id: ${task.id}. Report the outcome to the user. Start further work only if their request calls for it.`, "system", [], {
        recordPrompt: false,
      });
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

/** A thread made from another starts on its account, unless the project no longer uses it; only Claude's threads mind. */
function inheritedAccount(db: Db, projectId: string, agent: Thread["agent"], account: string | null | undefined): string {
  return startingAccount(db, projectId, account ?? undefined, agent === "claude" ? "inherited" : "unused");
}

/** The account a person chose for a Claude thread, refused when the project doesn't use it. Choosing none leaves the account the thread inherits. */
function chosenAccount(db: Db, projectId: string, choice: ThreadChoice): string | undefined {
  return choice.agent === "claude" && choice.claudeAccountId ? startingAccount(db, projectId, choice.claudeAccountId, "chosen") : undefined;
}

type ModelSettings = Pick<Thread, "agent" | "model" | "effort" | "fastMode"> & { claudeAccountId?: string | null | undefined };
type FirstThreadSettings = ModelSettings & Pick<Thread, "permissionMode">;
type FollowingSettings = Omit<ModelSettings, "claudeAccountId"> & { claudeAccountId: string };

/**
 * A thread's model and account as another thread had them, or the ones a person chose in their place, keeping its
 * account when they chose none. Fast mode stays on only for the same model; an account the project no longer uses goes.
 */
function followingSettings(db: Db, projectId: string, from: ModelSettings, choice: ThreadChoice | undefined): FollowingSettings {
  if (!choice) return { agent: from.agent, model: from.model, effort: from.effort, fastMode: from.fastMode, claudeAccountId: inheritedAccount(db, projectId, from.agent, from.claudeAccountId) };
  return {
    agent: choice.agent,
    model: choice.model,
    effort: choice.effort,
    fastMode: keptFastMode(from, choice),
    claudeAccountId: chosenAccount(db, projectId, choice) ?? inheritedAccount(db, projectId, choice.agent, from.claudeAccountId),
  };
}

function keptFastMode(from: Pick<ModelSettings, "agent" | "model" | "fastMode">, choice: ThreadChoice): boolean {
  return from.fastMode && from.agent === choice.agent && from.model === choice.model;
}

/** Whether a thread has the effort and account a person chose, beside the model: a creator thread on others isn't reused. */
function sameEffortAndAccount(thread: Thread, choice: ThreadChoice, account: string | undefined): boolean {
  return thread.effort === choice.effort && (!account || thread.claudeAccountId === account);
}

function buttonRun(button: TaskButton, threadMode: Thread["mode"] | undefined, threadPermission: Thread["permissionMode"]): Pick<Thread, "mode" | "permissionMode"> {
  // Settings are read without their schema, so a mode an earlier build saved, such as "act", reads as the thread's.
  const mode = ExecutionMode.safeParse(button.mode);
  return mode.success ? executionModeSettings(mode.data) : { mode: threadMode ?? "act", permissionMode: threadPermission };
}

function taskPrompt(lead: string, task: Task, images: string[], draft = ""): string {
  return [
    lead,
    `Task: ${task.title} (${task.id})\n\n${task.spec ?? ""}`,
    draft,
    images.length ? `Task images in document order (open them from these paths):\n${images.map((file, index) => `${index + 1}. ${file}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
