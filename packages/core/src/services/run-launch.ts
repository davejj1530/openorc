import { randomUUID } from "node:crypto";
import { audit, orchestration, runs, taskComments, taskForwardings, tasks, threads, type Db, type LedgerWriter } from "@openorc/db";
import { worktree } from "@openorc/git";
import { internalToolNames, type OpenOrcMcpServer } from "@openorc/mcp";
import {
  browserInstructions,
  harnessName,
  isHarnessId,
  normalizeModelEffort,
  type AgentEvent,
  type AgentKind,
  type ModelOption,
  type Project,
  type Run,
  type RunMode,
  type RunSpec,
  type Task,
  type Thread,
} from "@openorc/protocol";
import type { AgentLaunchEnvironment } from "@openorc/agents";
import type { Logger } from "../transport.js";
import type { EnvSnapshot } from "./shell-environment.js";
import {
  working,
  type LiveProcessBinding,
  type LiveRun,
  type Notification,
  type PreparedSession,
  type RunAdapterRegistry,
  type RunHooks,
  type RunScope,
  type StartRunInput,
  type TurnSettledOutcome,
} from "./run-types.js";
import type { WorkspaceLease, WorkspaceWriters } from "./workspace-writers.js";

type LaunchAttempt = {
  prepared: PreparedSession;
  run: Run;
  lease: WorkspaceLease;
  launch: AgentLaunchEnvironment;
  assertAdmission: () => void;
  phase: (name: string) => void;
  timing: [string, number][];
  locked: boolean;
};

/** Acquires the writer, records startup, launches the provider, then transfers the lease to the live entry. */
interface RunLaunchDependencies {
  db: Db;
  ledger: LedgerWriter;
  mcp: () => Promise<OpenOrcMcpServer>;
  writers: WorkspaceWriters;
  adapters: RunAdapterRegistry;
  hooks: Pick<RunHooks, "assertStart" | "taskImages" | "browserAvailable" | "claudeUserMcpServers" | "processRegistry" | "untrustedCheckout">;
  log: Logger;
  isClosing: () => boolean;
  live: ReadonlyMap<string, LiveRun>;
  emit: (event: AgentEvent) => void;
  invalidate: (keys: string[]) => void;
  keysFor: (scope: RunScope) => string[];
  notifyFor: (scope: RunScope, kind: Notification["kind"], title: string, body: string) => void;
  closeAndWait: (runId: string) => Promise<void>;
  bindLiveProcess: (binding: LiveProcessBinding) => void;
  applyThreadPermissions: (thread: Thread) => void;
  turnSettled: (run: Run, scope: RunScope, project: Project, outcome: TurnSettledOutcome) => void;
  taskBrief: (task: Task, project: Project, mode: RunMode, teamManaged: boolean) => string;
  threadBrief: (thread: Thread, project: Project, mode: RunMode) => string;
  models: (agent: AgentKind, environment: EnvSnapshot, launch: AgentLaunchEnvironment) => Promise<ModelOption[]>;
  validateFastMode: (agent: AgentKind, model: string | undefined, fastMode: boolean | undefined, environment: EnvSnapshot, launch: AgentLaunchEnvironment) => Promise<void>;
  liveRunForTask: (taskId: string) => Run | null;
  liveRunForThread: (threadId: string) => Run | null;
}

export class RunLaunch {
  constructor(private readonly deps: RunLaunchDependencies) {}

  /** Keep an admitted thread recoverable when setup fails before a provider run exists. */
  recordStartFailure(thread: Thread, input: { prompt: string; attachments?: string[] | undefined; promptRole?: "user" | "system" }, error: unknown): void {
    if (runs.listForThread(this.deps.db, thread.id).length) return;
    const runId = randomUUID(),
      ts = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    this.deps.db.transaction(() => {
      runs.insert(this.deps.db, {
        id: runId,
        taskId: null,
        threadId: thread.id,
        agent: thread.agent,
        model: thread.model,
        effort: thread.effort,
        fastMode: thread.fastMode,
        mode: thread.mode,
        permissionMode: thread.permissionMode,
      });
      runs.update(this.deps.db, runId, { state: "error", endedAt: ts, error: message });
    });
    this.deps.emit({
      type: "message.completed",
      runId,
      ts,
      messageId: `initial-${runId}`,
      role: input.promptRole ?? "user",
      text: input.prompt,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    });
    this.deps.emit({ type: "error", runId, ts, fatal: true, message });
    this.deps.emit({ type: "session.completed", runId, ts, status: "error", durationMs: 0 });
    this.deps.invalidate(this.deps.keysFor({ task: null, thread }));
    this.deps.notifyFor({ task: null, thread }, "error", thread.title, message);
  }

  async startSession(input: StartRunInput, environment: EnvSnapshot, launch: AgentLaunchEnvironment): Promise<Run> {
    // The admission closure must see the normalized input returned by prepareSession.
    let admitted = input;
    const assertAdmission = () => {
      if (this.deps.isClosing()) throw new Error("OpenOrc is closing.");
      this.deps.hooks.assertStart?.(admitted);
      admitted.assertCanStart?.();
    };
    const timing: [string, number][] = [];
    let phaseStarted = Date.now();
    const phase = (name: string) => {
      const now = Date.now();
      timing.push([name, now - phaseStarted]);
      phaseStarted = now;
    };
    if (!isHarnessId(input.agent)) throw new Error(`Provider ${input.agent} has no executable adapter.`);
    const prepared = await this.prepareSession(input, environment, launch, assertAdmission, phase);
    admitted = prepared.input;
    if (!isHarnessId(admitted.agent)) throw new Error(`Provider ${admitted.agent} has no executable adapter.`);
    assertAdmission();
    // Shared team members recheck admission while waiting for an exclusive coordinator operation.
    const lease = await this.deps.writers.acquire(prepared.cwd, `run ${prepared.runId}`, admitted.workspaceLease, {
      shared: true,
      ...(admitted.shared ? { waitForExclusive: assertAdmission, maxWaitMs: 60_000 } : {}),
    });
    phase("lease");
    const run = this.recordRun(prepared, lease, assertAdmission);
    const attempt: LaunchAttempt = { prepared, run, lease, launch, assertAdmission, phase, timing, locked: false };
    try {
      return await this.launchAdmitted(attempt);
    } catch (error) {
      await this.failStartup(attempt, error);
      throw error;
    }
  }

  private recordRun(prepared: PreparedSession, lease: WorkspaceLease, assertAdmission: () => void): Run {
    const { input, runId, model } = prepared;
    try {
      assertAdmission();
      return runs.insert(this.deps.db, {
        id: runId,
        workingDirectory: lease.paths[0]!,
        commentTurnId: input.scope.comment?.id,
        taskId: input.scope.task?.id ?? null,
        threadId: input.scope.thread?.id ?? null,
        agent: input.agent,
        model: model ?? null,
        effort: input.effort ?? null,
        fastMode: input.fastMode ?? false,
        mode: input.mode,
        permissionMode: input.permissionMode,
      });
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  private async launchAdmitted(attempt: LaunchAttempt): Promise<Run> {
    const { prepared, run, lease, launch, phase, timing, assertAdmission } = attempt;
    const { input, runId } = prepared;
    input.onCreated?.(run);
    if (input.scope.task) tasks.update(this.deps.db, input.scope.task.id, { status: "in_progress" });
    if (input.scope.thread) threads.touch(this.deps.db, input.scope.thread.id);
    this.recordPromptAndAudit(attempt);
    const mcp = await this.deps.mcp();
    phase("mcp");
    const internalMcp = this.internalMcp(input, runId, mcp);
    const spec = this.runSpec(prepared, lease, internalMcp);
    await this.lockTaskWorkspace(attempt);
    assertAdmission();
    // No await occurs between this permission read and the provider launch.
    const latestTeamThread = this.adoptTeamPermission(run, input, spec);
    phase("prepare");
    if (!isHarnessId(input.agent)) throw new Error(`Provider ${input.agent} has no executable adapter.`);
    const handle = this.deps.adapters[input.agent].start(spec, { ...launch, processRegistry: this.deps.hooks.processRegistry });
    phase("spawn");
    this.deps.emit({ type: "activity.updated", runId, ts: Date.now(), activityId: "startup", label: `Starting ${harnessName(input.agent)}`, status: "running" });
    const startTotal = timing.reduce((sum, [, ms]) => sum + ms, 0);
    if (startTotal > 300) this.deps.log.info(`run ${runId} took ${startTotal} ms before its process started: ${timing.map(([name, ms]) => `${name} ${ms}`).join(", ")}`);
    this.deps.bindLiveProcess({
      run,
      input,
      handle,
      workspaceLease: lease,
      internalMcp,
      providerPermissionMode: spec.permissionMode,
      ...(latestTeamThread ? { permissionGate: latestTeamThread.mode === "plan" ? ("review" as const) : latestTeamThread.permissionMode } : {}),
    });
    // The picker can change while catalog discovery or MCP startup is awaiting.
    const thread = input.scope.thread;
    const latestThread = thread ? threads.get(this.deps.db, thread.id) : null;
    if (latestThread && latestThread.permissionMode !== thread?.permissionMode) this.deps.applyThreadPermissions(latestThread);
    this.deps.invalidate(this.deps.keysFor(input.scope));
    return run;
  }

  private recordPromptAndAudit({ prepared, run, lease }: LaunchAttempt): void {
    const { input, runId, model, resumeSessionId, forkSession } = prepared;
    const { task, thread } = input.scope;
    if (input.recordPrompt !== false) {
      this.deps.emit({
        type: "message.completed",
        runId,
        ts: Date.now(),
        messageId: `${input.promptRole ?? "user"}-${Date.now()}`,
        role: input.promptRole ?? "user",
        text: input.prompt,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      });
    }
    audit.record(this.deps.db, {
      actor: input.promptRole === "system" ? "openorc" : "user",
      action: "run.start",
      resourceType: "run",
      resourceId: run.id,
      metadata: {
        taskId: task?.id ?? null,
        threadId: thread?.id ?? null,
        agent: input.agent,
        model,
        effort: input.effort ?? null,
        fastMode: input.fastMode ?? false,
        cwd: lease.paths[0],
        attachments: input.attachments?.length ?? 0,
        mode: input.mode,
        resume: Boolean(resumeSessionId),
        fork: forkSession,
      },
    });
  }

  private internalMcp(input: StartRunInput, runId: string, mcp: OpenOrcMcpServer): NonNullable<RunSpec["internalMcp"]> {
    return {
      serverName: `openorc_${randomUUID().replace(/-/g, "")}`,
      url: mcp.urlForRun(runId),
      toolNames: input.scope.comment ? ["ask_user", "approve", "task_comment_intent"] : [...internalToolNames],
    };
  }

  private runSpec(prepared: PreparedSession, lease: WorkspaceLease, internalMcp: NonNullable<RunSpec["internalMcp"]>): RunSpec {
    const { input, runId, model, taskImages, resumeSessionId, forkSession } = prepared;
    return {
      mode: input.mode,
      runId,
      agent: input.agent,
      fastMode: input.fastMode ?? false,
      cwd: lease.paths[0]!,
      prompt: input.prompt,
      permissionMode: input.mode === "plan" ? "review" : input.permissionMode,
      systemPromptAppendix: this.systemPrompt(input, taskImages),
      internalMcp,
      ...(model ? { model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(forkSession ? { forkSession: true } : {}),
      ...(input.agent === "claude" && this.deps.hooks.claudeUserMcpServers?.() === false ? { strictMcp: true } : {}),
      // Decided by the conversation, not its mode, so switching a review to Act keeps it.
      ...(input.scope.thread && this.deps.hooks.untrustedCheckout?.(input.scope.thread) ? { untrustedCheckout: true } : {}),
    };
  }

  private systemPrompt(input: StartRunInput, taskImages: string[]): string {
    return [
      !input.scope.comment && this.deps.hooks.browserAvailable ? browserInstructions : "",
      this.scopeBrief(input),
      taskImages.length ? `Task images in document order (open them from these paths):\n${taskImages.map((file, index) => `${index + 1}. ${file}`).join("\n")}` : "",
      input.handoff ?? "",
      input.scope.task ? (taskForwardings.target(this.deps.db, input.scope.task.id)?.context ?? "") : "",
      input.systemPromptAppendix ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private scopeBrief(input: StartRunInput): string {
    const { scope, project } = input;
    if (scope.comment) return "You are responding in task comments. This is read-only discussion, not task execution. Reply to the user in comments. No task or thread mutation tools are available.";
    if (scope.task) return this.deps.taskBrief(scope.task, project, input.mode, Boolean(input.teamAttemptId));
    return this.deps.threadBrief(scope.thread, project, input.mode);
  }

  private async lockTaskWorkspace(attempt: LaunchAttempt): Promise<void> {
    const { prepared, run } = attempt;
    const task = prepared.input.scope.task;
    if (!task?.worktreePath) return;
    await worktree
      .lock(prepared.input.project.rootPath, task.worktreePath, `openorc run ${run.id}`)
      .then(() => {
        attempt.locked = true;
      })
      .catch((error: unknown) => this.deps.log.warn(String(error)));
  }

  private adoptTeamPermission(run: Run, input: StartRunInput, spec: RunSpec): Thread | null {
    if (!input.teamAttemptId) return null;
    const { task, thread } = input.scope;
    const teamThreadId = thread?.id ?? task?.threadId;
    const latest = teamThreadId ? threads.get(this.deps.db, teamThreadId) : null;
    const currentTask = task ? tasks.get(this.deps.db, task.id) : null;
    if (
      !latest ||
      latest.projectId !== input.project.id ||
      !orchestration.getInstance(this.deps.db, latest.id) ||
      (task && (currentTask?.threadId !== latest.id || currentTask.projectId !== input.project.id))
    ) {
      throw new Error("Team permission ownership changed during startup.");
    }
    spec.permissionMode = input.mode === "plan" ? "review" : latest.permissionMode;
    if (run.permissionMode === latest.permissionMode) return latest;
    const previous = run.permissionMode;
    run.permissionMode = latest.permissionMode;
    runs.update(this.deps.db, run.id, { permissionMode: run.permissionMode });
    audit.record(this.deps.db, {
      actor: "openorc",
      action: "run.permissions_adopted",
      resourceType: "run",
      resourceId: run.id,
      metadata: { previous, permissionMode: run.permissionMode, providerPermissionMode: spec.permissionMode, reason: "team_startup" },
    });
    return latest;
  }

  private async failStartup(attempt: LaunchAttempt, error: unknown): Promise<void> {
    const { prepared, run, lease, locked } = attempt;
    const { input, runId } = prepared;
    const message = error instanceof Error ? error.message : String(error);
    const launched = this.deps.live.get(runId);
    if (launched) {
      launched.failed = message;
      await this.deps.closeAndWait(runId).catch((closeError) => this.deps.log.error(`run ${runId} could not finish closing after startup failure: ${String(closeError)}`));
      return;
    }
    runs.update(this.deps.db, runId, { state: "error", error: message, endedAt: Date.now() });
    const task = input.scope.task;
    if (locked && task?.worktreePath) await worktree.unlock(input.project.rootPath, task.worktreePath).catch(() => undefined);
    if (task && tasks.get(this.deps.db, task.id)?.status === "in_progress" && task.status !== "in_progress") tasks.update(this.deps.db, task.id, { status: task.status });
    this.deps.emit({ type: "error", runId, ts: Date.now(), fatal: true, message });
    this.deps.emit({ type: "session.completed", runId, ts: Date.now(), status: "error", durationMs: Math.max(0, Date.now() - run.startedAt) });
    this.deps.ledger.flush();
    this.deps.invalidate(this.deps.keysFor(input.scope));
    lease.release();
    this.deps.turnSettled(run, input.scope, input.project, { status: "error", snapshotId: null, error: message });
  }

  /** Resolve launch inputs before taking a writer; callers still fence admission after every later wait. */
  private async prepareSession(input: StartRunInput, environment: EnvSnapshot, launch: AgentLaunchEnvironment, assertAdmission: () => void, phase: (name: string) => void): Promise<PreparedSession> {
    const { scope, agent } = input;
    assertAdmission();
    if (scope.comment && (input.mode !== "plan" || input.permissionMode !== "review" || input.resumeFrom)) throw new Error("Comment turns require a read-only discussion session.");
    // Task images belong to the brief, not the user's message.
    const taskImages = input.collectTaskImages !== false && scope.task?.spec ? ((await this.deps.hooks.taskImages?.(scope.task.spec)) ?? []) : [];
    await this.deps.validateFastMode(agent, input.model, input.fastMode, environment, launch);
    assertAdmission();
    phase("checks");
    await this.closePrevious(input);
    const cwd = this.workingDirectory(input);
    const runId = randomUUID();
    const model = input.model ?? (await this.deps.models(agent, environment, launch).catch(() => [] as ModelOption[])).find((item) => item.isDefault)?.id;
    input = { ...input, effort: normalizeModelEffort(agent, model, input.effort) };
    phase("model");
    const { resumeSessionId, forkSession } = this.resumeTarget(input, model);
    return { input, taskImages, cwd, runId, model, resumeSessionId, forkSession };
  }

  private async closePrevious(input: StartRunInput): Promise<void> {
    const { scope } = input;
    if (scope.comment || input.shared) return;
    const previous = scope.thread ? this.deps.liveRunForThread(scope.thread.id) : this.deps.liveRunForTask(scope.task!.id);
    if (!previous) return;
    const entry = this.deps.live.get(previous.id)!;
    if (working(entry)) throw new Error("Wait for the current turn to finish before changing its session settings.");
    await this.deps.closeAndWait(previous.id);
  }

  private workingDirectory(input: StartRunInput): string {
    const { task, thread } = input.scope;
    if (task?.workspaceMode === "current") return input.project.rootPath;
    if (task) return task.worktreePath ?? input.project.rootPath;
    return thread?.worktreePath ?? input.project.rootPath;
  }

  private resumeTarget(input: StartRunInput, model: string | undefined): { resumeSessionId: string | null | undefined; forkSession: boolean } {
    const { scope, agent } = input;
    const own = !scope.comment && input.resume ? (runs.lastSession(this.deps.db, scope.task ? { taskId: scope.task.id } : { threadId: scope.thread.id }, agent) ?? undefined) : undefined;
    const commentRun = scope.comment?.resumeRunId ? runs.get(this.deps.db, scope.comment.resumeRunId) : null;
    if (scope.comment && input.resume) this.assertCommentResume(scope.comment.task, commentRun, agent, model, input);
    const resumeSessionId = own ?? (scope.comment && input.resume ? commentRun?.externalSessionId : input.resumeFrom?.sessionId);
    return { resumeSessionId, forkSession: !own && Boolean(input.resumeFrom?.fork) };
  }

  private assertCommentResume(task: Task, commentRun: Run | null, agent: AgentKind, model: string | undefined, input: StartRunInput): void {
    const parent = commentRun?.commentTurnId ? taskComments.attempt(this.deps.db, commentRun.commentTurnId) : null;
    if (
      !commentRun?.externalSessionId ||
      parent?.taskId !== task.id ||
      commentRun.agent !== agent ||
      commentRun.model !== model ||
      commentRun.effort !== (input.effort ?? null) ||
      commentRun.mode !== "plan" ||
      commentRun.permissionMode !== "review"
    ) {
      throw new Error("Only this task's matching read-only comment session can be resumed.");
    }
  }
}
