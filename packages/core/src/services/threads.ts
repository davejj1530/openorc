import {
  audit,
  plans,
  settings,
  checkpoints,
  messages,
  orchestration,
  runs as runRepo,
  tasks,
  teamDeletedThreads,
  teamRuntime,
  teamWorkspaces,
  threads,
  threadQueue,
  type Db,
  type ThreadListFilter,
} from "@openorc/db";
import { diffStat, git, pinObject, switchFiles, teamTransfer, treeHash } from "@openorc/git";
import {
  WORKSPACE_ID,
  normalizeModelEffort,
  normalizeModelSettings,
  executionModeUnavailable,
  type AgentKind,
  type ChangePreview,
  type PermissionPreset,
  type Run,
  type RunMode,
  type Thread,
  type ThreadCheckpoint,
  type ThreadSearchHit,
  type ThreadSummary,
  type ThreadMessage,
  type WorkspaceMode,
} from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../transport.js";
import { titleFromPrompt, type StartThreadInput, type ThreadPatch, type ThreadTitler } from "./thread-inputs.js";
import type { RunService } from "./runs.js";
import type { WorkspaceService } from "./workspace.js";
import { directory, executionProject } from "./workspace-home.js";
import { workspaceWriters, type WorkspaceWriters } from "./workspace-writers.js";
import { checkpointRefs, unpinProjectRefs } from "./checkpoint-refs.js";
import { ThreadMoves, fileChanges } from "./thread-moves.js";
import { ThreadMessageQueue } from "./thread-message-queue.js";
import { ThreadTaskExecution } from "./thread-task-execution.js";
import { ThreadAgentTools } from "./thread-agent-tools.js";

/** How many agent messages in a row may pass between conversations before a person has to write. */
export { MAX_AGENT_HOPS } from "./thread-agent-tools.js";

export { titleFromPrompt, type SpawnTaskInput, type StartThreadInput, type ThreadPatch, type ThreadTitler } from "./thread-inputs.js";

/**
 * Threads are the conversation the user has with an agent in the project
 * root or in a worktree of the thread's own. From a thread, the user or the
 * agent records tasks and works on them here. Task documents have their own
 * status; the conversation remains available after any task finishes.
 */
export class ThreadService {
  private readonly messageQueue: ThreadMessageQueue;
  private readonly taskExecution: ThreadTaskExecution;
  private readonly agentTools: ThreadAgentTools;

  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly workspaces: WorkspaceService,
    private readonly invalidate: (keys: string[]) => void,
    private readonly log: Logger,
    private readonly titler: ThreadTitler,
    private readonly writers: WorkspaceWriters = workspaceWriters,
    private readonly onTeamModeChanged?: (threadId: string) => void,
  ) {
    this.messageQueue = new ThreadMessageQueue(
      db,
      runs,
      invalidate,
      log,
      (id) => this.rejectPinnedTeam(id),
      (id, input) => this.continueThread(id, input),
      (input) => this.queueFollowUp(input),
      () => this.stopAccepting(),
    );
    this.taskExecution = new ThreadTaskExecution(db, runs, workspaces, invalidate, log, writers, this.messageQueue, {
      get: (id) => this.get(id),
      executionThreadFor: (id) => this.executionThreadFor(id),
      taskThreadForStart: (id, selected) => this.taskThreadForStart(id, selected),
      continueThread: (id, input) => this.continueThread(id, input),
      handoffBrief: (thread, own) => this.agentTools.handoffBrief(thread, own),
      rejectPinnedTeam: (id) => this.rejectPinnedTeam(id),
    });
    this.agentTools = new ThreadAgentTools(db, runs, invalidate, {
      spawnTask: (thread, input, origin) => this.spawnTask(thread, input, origin),
      rejectPinnedTeam: (id) => this.rejectPinnedTeam(id),
      send: (id, text, from, attribution, options) => this.send(id, text, from, attribution, options),
      messages: (id) => this.messages(id),
      withCheckoutBranches: (rows) => this.withCheckoutBranches(rows),
    });
  }

  list(filter: { projectId?: string; projectsOnly?: boolean; filter?: ThreadListFilter; limit?: number; offset?: number } = {}): ThreadSummary[] {
    return threads.list(this.db, filter).map((t) => this.summarize(t));
  }

  /** A deleted team conversation reads as absent; its saved tasks reach it through their own endpoints. */
  get(id: string): ThreadSummary | null {
    const t = threads.get(this.db, id);
    return t && !teamDeletedThreads.has(this.db, id) ? this.summarize(t) : null;
  }

  /** Local conversations can have missing or stale metadata. Read their checkout's HEAD for display. */
  withCheckoutBranches<T extends Thread>(rows: T[]): Promise<T[]> {
    return this.agentTools.withCheckoutBranches(rows);
  }

  private summarize(t: Thread): ThreadSummary {
    const own = tasks.list(this.db, { threadId: t.id });
    const instance = orchestration.getInstance(this.db, t.id);
    const execution = instance ? teamRuntime.activeForThread(this.db, t.id) : null;
    const executionRuns = new Set(execution?.attempts.flatMap((attempt) => (attempt.runId ? [attempt.runId] : [])) ?? []);
    const needsApproval = execution ? this.runs.pending().some((approval) => executionRuns.has(approval.runId)) : false;
    const heldByMode = (actor: NonNullable<typeof execution>["actors"][number]) =>
      t.mode === "plan" && ((actor.modeHold === "plan" && actor.state === "waiting") || (actor.parentId !== null && actor.state === "queued"));
    const working = execution?.actors.some((actor) => !heldByMode(actor) && ["queued", "starting", "running"].includes(actor.state)) || [...executionRuns].some((runId) => this.runs.isLive(runId));
    const modeHeld = execution?.actors.some(heldByMode);
    let activity: ThreadSummary["activity"];
    if (!execution) activity = this.runs.threadActivity(t.id);
    else if (execution.state === "stopping") activity = "running";
    else if (needsApproval) activity = "waiting";
    else if (working || (execution.state === "active" && !modeHeld)) activity = "running";
    else activity = "waiting";
    // A team's work runs on its attempts, which are bound to tasks rather than
    // to this thread, so the thread's own live run is empty for them. Take the
    // most recent event across the execution's runs, as the activity above does.
    const lastAgentEventAt = execution
      ? [...executionRuns].reduce<number | null>((latest, runId) => {
          const at = this.runs.lastAgentEventAt(runId);
          return at !== null && (latest === null || at > latest) ? at : latest;
        }, null)
      : this.runs.threadLastAgentEventAt(t.id);
    return {
      ...t,
      hasStarted: Boolean(this.db.stmt("SELECT 1 FROM runs WHERE thread_id = ? LIMIT 1").get(t.id) || this.db.stmt("SELECT 1 FROM team_executions WHERE thread_id = ? LIMIT 1").get(t.id)),
      teamInstanceId: instance?.id ?? null,
      agents: (instance ? orchestration.getRevision(this.db, instance.teamRevisionId)?.members.map((member) => member.settings.agent) : null) ?? [t.agent],
      activity,
      // Activity the user has not looked at yet, once the agent is done with it.
      unread: activity === "idle" && (t.seenAt === null || t.lastActivityAt > t.seenAt),
      session: this.runs.threadSession(t.id),
      context: this.runs.threadContext(t.id),
      queued: threadQueue.list(this.db, t.id),
      lastAgentEventAt,
      taskCount: own.filter((x) => x.status !== "archived").length,
      openTaskCount: own.filter((x) => x.status === "proposed" || x.status === "backlog" || x.status === "in_progress" || x.status === "review").length,
    };
  }

  private thread(id: string): Thread {
    const t = threads.get(this.db, id);
    if (!t) throw new Error(`thread ${id} not found`);
    return t;
  }

  private rejectPinnedTeam(threadId: string | null): void {
    if (threadId && (orchestration.getInstance(this.db, threadId) || teamRuntime.activeForThread(this.db, threadId))) {
      throw new Error("This thread is managed by a saved team. Use its team execution controls.");
    }
  }

  /** Organization never hides unfinished team work. */
  teamQuiescenceReason(threadId: string): string | null {
    if (!orchestration.getInstance(this.db, threadId) && !teamRuntime.activeForThread(this.db, threadId)) return null;
    const rows = this.db.stmt("SELECT id FROM team_executions WHERE thread_id = ?").all(threadId) as { id: string }[];
    const executions = rows.map((row) => teamRuntime.get(this.db, row.id)!);
    if (executions.some((execution) => !["completed", "stopped"].includes(execution.state))) return "Finish or stop the team's unfinished execution before this action.";
    if (executions.some((execution) => execution.attempts.some((attempt) => ["starting", "running"].includes(attempt.state) || (attempt.state === "attention" && attempt.endedAt === null))))
      return "Wait for every team writer to finish closing before this action.";
    const owned = tasks.list(this.db, { threadId });
    if (this.runs.liveRunForThread(threadId) || owned.some((task) => this.runs.liveRunForTask(task.id))) return "Wait for every team writer to finish closing before this action.";
    const runIds = new Set([
      ...runRepo.listForThread(this.db, threadId).map((run) => run.id),
      ...owned.flatMap((task) => runRepo.listForTask(this.db, task.id).map((run) => run.id)),
      ...executions.flatMap((execution) => execution.attempts.flatMap((attempt) => (attempt.runId ? [attempt.runId] : []))),
    ]);
    if (this.runs.pending().some((approval) => runIds.has(approval.runId))) return "Resolve the team's pending requests before this action.";
    if (executions.some((execution) => teamWorkspaces.publications(this.db, execution.id).some((publication) => publication.state !== "applied")))
      return "Resolve the team's retained publication before this action.";
    return null;
  }

  async start(input: StartThreadInput, internal?: { assertCanAdmit(): void; onAdmitted(thread: Thread): void }): Promise<{ thread: Thread; run: Run }> {
    input = normalizeModelSettings(input);
    await this.runs.validateFastMode(input.agent, input.model, input.fastMode);
    internal?.assertCanAdmit();
    if (input.workingDirectory && input.projectId !== WORKSPACE_ID) throw new Error("Only Workspace conversations can choose a working folder.");
    const home = executionProject(this.db, { projectId: input.projectId });
    const project = input.projectId === WORKSPACE_ID ? { ...home, rootPath: await directory(input.workingDirectory ?? home.rootPath) } : home;
    const workspaceMode = input.checkout ? "worktree" : (input.workspaceMode ?? "current");
    if (project.id === WORKSPACE_ID && workspaceMode === "worktree") throw new Error("Workspace conversations run in a folder. Open a project to create a worktree.");
    const id = randomUUID();
    const title = input.title?.trim() || titleFromPrompt(input.prompt);
    const destination = this.workspaces.threadPath({ id, title, workspaceMode, worktreePath: input.checkout?.path ?? null }, project);
    return this.writers.withLease(
      destination,
      `starting thread ${id}`,
      async (workspaceLease) => {
        let thread = this.db.transaction(() => {
          internal?.assertCanAdmit();
          const admitted = threads.insert(this.db, {
            id,
            projectId: project.id,
            title,
            agent: input.agent,
            model: input.model ?? null,
            effort: input.effort ?? null,
            fastMode: input.fastMode ?? false,
            mode: input.mode,
            permissionMode: input.permissionMode,
            workspaceMode,
          });
          audit.record(this.db, {
            actor: "user",
            action: "thread.create",
            resourceType: "thread",
            resourceId: admitted.id,
            metadata: { projectId: project.id, agent: input.agent, workspaceMode: admitted.workspaceMode },
          });
          if (project.id === WORKSPACE_ID) admitted.workingDirectory = threads.update(this.db, admitted.id, { workingDirectory: project.rootPath }).workingDirectory;
          const adopted = input.checkout ? threads.update(this.db, admitted.id, { worktreePath: input.checkout.path, baseSha: input.checkout.baseSha }) : admitted;
          internal?.onAdmitted(adopted);
          return adopted;
        });
        this.invalidate(["threads", `thread:${thread.id}`]);
        try {
          thread = await this.workspaces.prepareThread(thread, project, input.baseRef, workspaceLease);
          const run = await this.runs.start({
            scope: { task: null, thread },
            project,
            agent: input.agent,
            model: input.model,
            effort: input.effort,
            fastMode: input.fastMode,
            attachments: input.attachments,
            mode: input.mode,
            permissionMode: input.permissionMode,
            prompt: input.prompt,
            ...(input.promptRole ? { promptRole: input.promptRole } : {}),
            resume: false,
            workspaceLease,
          });
          // The user is looking at what they just started.
          threads.update(this.db, thread.id, { seenAt: Date.now() });
          this.invalidate(["threads", `thread:${thread.id}`]);
          return { thread, run };
        } catch (error) {
          this.runs.recordStartFailure(thread, input, error);
          throw error;
        }
      },
      undefined,
      { shared: true },
    );
  }

  /** Admit a conversation without starting a provider: routing questions are real conversation turns. */
  async createWorkspaceConversation(input: Pick<StartThreadInput, "agent" | "model" | "permissionMode" | "title"> & { mode?: RunMode }): Promise<Thread> {
    const home = executionProject(this.db, { projectId: WORKSPACE_ID });
    const cwd = await directory(home.rootPath);
    const thread = this.db.transaction(() => {
      const row = threads.insert(this.db, {
        projectId: WORKSPACE_ID,
        title: input.title ?? "Slack conversation",
        agent: input.agent,
        model: input.model ?? null,
        mode: input.mode ?? "act",
        permissionMode: input.permissionMode,
      });
      return threads.update(this.db, row.id, { workingDirectory: cwd });
    });
    this.invalidate(["threads", `thread:${thread.id}`]);
    return thread;
  }

  messages(id: string): ThreadMessage[] {
    return this.agentTools.messages(id);
  }

  recordMessage(threadId: string, message: ThreadMessage): void {
    this.messageQueue.recordMessage(threadId, message);
  }

  /**
   * A follow-up turn on a thread. Switching provider mid-thread hands the new
   * agent a brief of the conversation so far, since it cannot read the other
   * provider's session. The thread remembers the last agent, model, and
   * effort so its tasks inherit them.
   */
  plans(id: string) {
    this.thread(id);
    return plans.list(this.db, id);
  }

  async implementPlan(id: string, planId: string, permissionMode: PermissionPreset): Promise<Run> {
    this.rejectPinnedTeam(id);
    const thread = this.thread(id);
    const unavailable = executionModeUnavailable(thread.agent, permissionMode);
    if (unavailable) throw new Error(unavailable);
    const receipt = `plan.implementation:${id}:${planId}`;
    const saved = settings.get(this.db, receipt);
    if (saved) {
      const prior = JSON.parse(saved) as { permissionMode: PermissionPreset; runId?: string };
      if (prior.permissionMode !== permissionMode) throw new Error("This plan revision already has an implementation with a different mode.");
      const run = prior.runId ? runRepo.get(this.db, prior.runId) : null;
      if (run) return run;
      throw new Error("Implementation was already requested. Check this conversation before retrying; it will not be run twice.");
    }
    const plan = plans.list(this.db, id)[0];
    if (!plan || plan.id !== planId || plan.state !== "ready" || !plan.text.trim()) throw new Error("The plan changed or is unfinished. Review the latest completed revision first.");
    if (this.runs.threadActivity(id) !== "idle") throw new Error("Wait for this turn to finish before implementing the plan.");
    if (thread.archivedAt) throw new Error("Unarchive this conversation before implementing its plan.");
    // Reserve before any await. An uncertain launch never silently replays an implementation.
    settings.set(this.db, receipt, JSON.stringify({ permissionMode }));
    const run = await this.continueThread(id, {
      agent: thread.agent,
      model: thread.model ?? undefined,
      effort: thread.effort ?? undefined,
      fastMode: thread.fastMode,
      mode: "act",
      permissionMode,
      attachments: undefined,
      prompt: `Implement the approved plan, revision ${plan.revision} (${plan.id}). Follow the selected execution mode.\n\n${plan.text}`,
    });
    settings.set(this.db, receipt, JSON.stringify({ permissionMode, runId: run.id }));
    audit.record(this.db, { actor: "user", action: "plan.implement", resourceType: "thread", resourceId: id, metadata: { planId, revision: plan.revision, permissionMode, runId: run.id } });
    return run;
  }

  async exportPlan(id: string, planId: string, filename: string): Promise<{ path: string }> {
    const thread = this.thread(id);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(filename) || filename.length > 120) throw new Error("Choose a Markdown filename without directories.");
    const plan = plans.list(this.db, id).find((p) => p.id === planId);
    if (!plan || plan.state !== "ready") throw new Error("Only completed plan revisions can be exported.");
    const project = executionProject(this.db, thread);
    const file = path.join(thread.worktreePath ?? project.rootPath, filename);
    await writeFile(file, plan.text + "\n", { flag: "wx" });
    audit.record(this.db, { actor: "user", action: "plan.export", resourceType: "thread", resourceId: id, metadata: { planId, file } });
    return { path: file };
  }

  async continueThread(
    id: string,
    input: {
      agent: AgentKind;
      model: string | undefined;
      effort: string | undefined;
      fastMode?: boolean | undefined;
      mode: RunMode;
      permissionMode: PermissionPreset;
      prompt: string;
      attachments: string[] | undefined;
      promptRole?: "user" | "system";
      recordPrompt?: boolean;
      fresh?: boolean;
      workingDirectory?: string;
      baseRef?: string;
      onCreated?: (run: Run) => void;
      assertCanStart?: () => void;
    },
  ): Promise<Run> {
    input = normalizeModelSettings(input);
    this.rejectPinnedTeam(id);
    const thread = this.thread(id);
    if (input.workingDirectory && thread.projectId !== WORKSPACE_ID) throw new Error("Only Workspace conversations can change folders.");
    const currentProject = executionProject(this.db, thread);
    const nextDirectory = thread.projectId === WORKSPACE_ID ? await directory(input.workingDirectory ?? currentProject.rootPath) : currentProject.rootPath;
    const folderChanged = nextDirectory !== currentProject.rootPath;
    const project = { ...currentProject, rootPath: nextDirectory };
    if (folderChanged) input = { ...input, fresh: true };
    const own = runRepo.listForThread(this.db, thread.id);
    if (thread.projectId === WORKSPACE_ID && own.length && own.at(-1)?.agent !== input.agent) input = { ...input, fresh: true };
    // A fresh start, or a provider that cannot read the old session, gets a brief instead of the session.
    const switching = own.length > 0 && !own.some((r) => r.agent === input.agent);
    const handoff = own.length > 0 && (switching || input.fresh) ? this.agentTools.handoffBrief(thread, own) : undefined;
    await this.runs.validateFastMode(input.agent, input.model, input.fastMode);
    const previous = this.runs.liveRunForThread(id);
    if (previous) {
      if (this.runs.threadActivity(id) !== "idle") throw new Error("Wait for the current turn to finish before changing its session settings.");
      await this.runs.closeAndWait(previous.id);
    }
    return this.writers.withLease(
      this.workspaces.threadPath(thread, project),
      `continuing thread ${id}`,
      async (workspaceLease) => {
        this.rejectPinnedTeam(id);
        input.assertCanStart?.();
        if (folderChanged) threads.update(this.db, id, { workingDirectory: nextDirectory });
        if (
          thread.agent !== input.agent ||
          thread.model !== (input.model ?? null) ||
          thread.effort !== (input.effort ?? null) ||
          thread.fastMode !== (input.fastMode ?? false) ||
          thread.mode !== input.mode ||
          thread.permissionMode !== input.permissionMode
        ) {
          threads.update(this.db, thread.id, {
            agent: input.agent,
            model: input.model ?? null,
            effort: input.effort ?? null,
            fastMode: input.fastMode ?? false,
            mode: input.mode,
            permissionMode: input.permissionMode,
          });
        }
        if (thread.snoozedUntil) threads.update(this.db, thread.id, { snoozedUntil: null });
        // Task-opened local conversations need initial Git metadata too; missing worktrees are re-created before starting.
        const fresh = await this.workspaces.prepareThread(this.thread(id), project, input.baseRef, workspaceLease);
        const run = await this.runs.start({
          scope: { task: null, thread: fresh },
          project,
          agent: input.agent,
          model: input.model,
          effort: input.effort,
          fastMode: input.fastMode,
          attachments: input.attachments,
          mode: input.mode,
          permissionMode: input.permissionMode,
          prompt: input.prompt,
          recordPrompt: input.recordPrompt,
          onCreated: input.onCreated,
          assertCanStart: input.assertCanStart,
          ...(input.promptRole ? { promptRole: input.promptRole } : {}),
          resume: !input.fresh,
          ...(input.fresh ? {} : (this.resumeSourceFor(fresh, input.agent) ?? {})),
          ...(handoff ? { handoff } : {}),
          workspaceLease,
        });
        if (input.promptRole !== "system") threads.update(this.db, thread.id, { seenAt: Date.now() });
        this.invalidate(["threads", `thread:${thread.id}`]);
        return run;
      },
      undefined,
      { shared: true },
    );
  }

  /** A fork's first run continues its parent's session as a new one; the parent keeps its own history. */
  private resumeSourceFor(thread: Thread, agent: AgentKind): { resumeFrom: { sessionId: string; fork: boolean } } | null {
    if (!thread.forkedFromId || runRepo.lastSession(this.db, { threadId: thread.id }, agent)) return null;
    const parentSession = runRepo.lastSession(this.db, { threadId: thread.forkedFromId }, agent);
    return parentSession ? { resumeFrom: { sessionId: parentSession, fork: true } } : null;
  }

  /**
   * After the first exchange, a thread gets a real name the way Codex and
   * Claude Desktop do it: a cheap model reads the request and the reply and
   * names the subject. Only while the title is still the prompt's first line,
   * so a rename by the user always wins. A finished turn also wakes a snoozed
   * thread and sends the next queued message.
   */
  async onTurnCompleted(thread: Thread, exchange: { prompt: string | null; reply: string | null }): Promise<void> {
    if (thread.snoozedUntil) {
      threads.update(this.db, thread.id, { snoozedUntil: null });
      this.invalidate(["threads", `thread:${thread.id}`]);
    }
    void this.messageQueue.drainQueue(thread.id);
    if (!exchange.prompt || thread.title !== titleFromPrompt(exchange.prompt)) return;
    let title: string | null = null;
    try {
      title = await this.titler({ request: exchange.prompt, reply: exchange.reply }, thread.agent);
    } catch (e) {
      this.log.warn(`could not name thread ${thread.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const fresh = threads.get(this.db, thread.id);
    if (!title || !fresh || fresh.title !== thread.title) return;
    threads.update(this.db, thread.id, { title });
    this.invalidate(["threads", `thread:${thread.id}`]);
  }

  /** The thread went idle without a turn ending, as when its background work was stopped: send the next queued message. */
  onIdle(thread: Thread): void {
    void this.messageQueue.drainQueue(thread.id);
  }

  update(id: string, patch: ThreadPatch, scope: { taskId?: string } = {}): Thread {
    // Through a saved task of a deleted conversation only next-turn controls may change; nothing resurrects the owner.
    if (teamDeletedThreads.has(this.db, id)) {
      const allowed = new Set(["mode", "permissionMode", "draft"]);
      const keys = Object.keys(patch).filter((key) => (patch as Record<string, unknown>)[key] !== undefined);
      if (!scope.taskId || tasks.get(this.db, scope.taskId)?.threadId !== id) throw new Error("This conversation was deleted. Continue from one of its saved tasks.");
      if (keys.some((key) => !allowed.has(key))) throw new Error("A deleted conversation only accepts mode, permission and draft changes through its saved tasks.");
    }
    const structural: (keyof ThreadPatch)[] = ["agent", "model", "effort", "fastMode"];
    if (structural.some((key) => patch[key] !== undefined)) this.rejectPinnedTeam(id);
    if (structural.some((key) => patch[key] !== undefined)) {
      const next = { ...this.thread(id), ...patch };
      patch = { ...patch, effort: normalizeModelEffort(next.agent, next.model, next.effort) };
    }
    if (["archived", "done", "snoozedUntil"].some((key) => patch[key as keyof ThreadPatch] !== undefined)) {
      const reason = this.teamQuiescenceReason(id);
      if (reason) throw new Error(reason);
    }
    const previousPermission = patch.permissionMode === undefined ? null : this.thread(id).permissionMode;
    const previousMode = patch.mode === undefined ? null : this.thread(id).mode;
    if (patch.permissionMode !== undefined || patch.mode !== undefined) this.runs.assertThreadPermissions(id);
    const { archived, pinned, done, seen, ...rest } = patch;
    const now = Date.now();
    const t = threads.update(this.db, id, {
      ...rest,
      ...(archived === undefined ? {} : { archivedAt: archived ? now : null }),
      // A pinned thread that is put away loses its pin; the pin meant "keep this in front of me".
      ...(pinned === undefined ? {} : { pinnedAt: pinned ? now : null }),
      // Legacy clients may still send done; conversations always remain continuable.
      doneAt: null,
      ...(seen === undefined ? {} : { seenAt: seen ? now : null }),
    });
    if (archived !== undefined || done !== undefined || pinned !== undefined || patch.snoozedUntil !== undefined) {
      audit.record(this.db, {
        actor: "user",
        action: archived ? "thread.archive" : "thread.update",
        resourceType: "thread",
        resourceId: id,
        metadata: { archived, done, pinned, snoozedUntil: patch.snoozedUntil },
      });
    }
    if (patch.permissionMode !== undefined || patch.mode !== undefined) {
      const policy = this.runs.applyThreadPermissions(t);
      if (previousPermission !== null && previousPermission !== t.permissionMode)
        audit.record(this.db, {
          actor: "user",
          action: "thread.permissions_requested",
          resourceType: "thread",
          resourceId: id,
          metadata: { previous: previousPermission, requested: policy.requested, effective: policy.effective, pendingRestart: policy.pendingRestart, runs: policy.runs },
        });
      if (previousMode !== null && previousMode !== t.mode) {
        audit.record(this.db, {
          actor: "user",
          action: "thread.mode_requested",
          resourceType: "thread",
          resourceId: id,
          metadata: { previous: previousMode, requested: t.mode, effective: policy.mode?.effective, pending: policy.mode?.pending },
        });
        if (orchestration.getInstance(this.db, id)) this.onTeamModeChanged?.(id);
      }
    }
    this.invalidate(["threads", `thread:${id}`]);
    if (archived === false) void this.messageQueue.drainQueue(id);
    return t;
  }

  /** Forks share their parent's worktree; it goes only with the last thread that uses it. */
  private worktreeShared(thread: Thread): boolean {
    if (!thread.worktreePath) return false;
    return threads.list(this.db, { projectId: thread.projectId, filter: "all" }).some((t) => t.id !== thread.id && t.worktreePath === thread.worktreePath);
  }

  async delete(id: string): Promise<void> {
    const thread = this.thread(id);
    const live = this.runs.liveRunForThread(id);
    if (live) await this.runs.closeAndWait(live.id);
    const project = executionProject(this.db, thread);
    await this.writers.withLease(this.workspaces.threadPath(thread, project), `deleting thread ${id}`, async (lease) => {
      if (thread.worktreePath && !this.worktreeShared(thread)) {
        await this.workspaces.cleanupThread(thread, project, {}, lease);
      }

      threads.delete(this.db, id);
      // Its checkpoints go with it; nothing else keeps their trees.
      await unpinProjectRefs(project, checkpointRefs(id)).catch((e: unknown) => this.log.warn(`checkpoint refs of thread ${id} were kept: ${e instanceof Error ? e.message : String(e)}`));
      this.invalidate(["threads", "tasks", "inbox"]);
    });
  }

  /**
   * A new thread that carries this conversation forward from a chosen point,
   * leaving the original as it is. Same settings, same workspace; the first
   * message resumes the parent's session as a fork.
   */
  fork(id: string, upToRunId?: string): Thread {
    const parent = this.thread(id);
    const own = runRepo.listForThread(this.db, id);
    const at = upToRunId ? own.find((r) => r.id === upToRunId) : own.at(-1);
    if (upToRunId && !at) throw new Error(`run ${upToRunId} is not part of this thread`);
    const forked = threads.insert(this.db, {
      projectId: parent.projectId,
      title: `${parent.title} (fork)`,
      agent: parent.agent,
      model: parent.model,
      effort: parent.effort,
      fastMode: parent.fastMode,
      mode: parent.mode,
      permissionMode: parent.permissionMode,
      workspaceMode: parent.workspaceMode,
      forkedFromId: parent.id,
      forkedAtRunId: at?.id ?? null,
    });
    // A fork shares its parent's worktree: same branch, same files, two conversations.
    const thread = threads.update(this.db, forked.id, {
      workingDirectory: parent.workingDirectory ?? null,
      branch: parent.branch,
      worktreePath: parent.worktreePath,
      baseSha: parent.baseSha,
      baseBranch: parent.baseBranch,
      seenAt: Date.now(),
    });
    audit.record(this.db, { actor: "user", action: "thread.fork", resourceType: "thread", resourceId: thread.id, metadata: { from: parent.id, at: at?.id ?? null } });
    this.invalidate(["threads", `thread:${thread.id}`]);
    return thread;
  }

  /** The runs a conversation is made of: the parent's up to the fork point, then the thread's own. */
  conversationRuns(id: string): Run[] {
    const thread = this.thread(id);
    const own = runRepo.listForThread(this.db, id);
    if (!thread.forkedFromId) return own;
    const parent = threads.get(this.db, thread.forkedFromId) ? this.conversationRuns(thread.forkedFromId) : [];
    const cut = thread.forkedAtRunId ? parent.findIndex((r) => r.id === thread.forkedAtRunId) : -1;
    return [...(cut >= 0 ? parent.slice(0, cut + 1) : parent), ...own];
  }

  search(query: string, options: { projectId?: string; limit?: number } = {}): ThreadSearchHit[] {
    return messages.search(this.db, query, options);
  }

  /* Workspace */

  /**
   * Moves the thread between the checkout and a worktree of its own. The
   * uncommitted changes go with it: applied at the destination, then taken
   * back at the source, file by file, only once they landed.
   */
  async moveWorkspace(id: string, to: WorkspaceMode): Promise<Thread> {
    const thread = this.thread(id);
    if (thread.projectId === WORKSPACE_ID) throw new Error("Workspace conversations use their selected folder. Open a project for Git worktree actions.");
    if (thread.workspaceMode === to) return thread;
    if (this.runs.liveRunForThread(id)) throw new Error("end the current turn before moving the thread");
    const project = executionProject(this.db, thread);
    const from = thread.worktreePath ?? project.rootPath;
    const destination = to === "worktree" ? { ...thread, workspaceMode: to, worktreePath: null, branch: null, baseSha: null } : { ...thread, workspaceMode: to, worktreePath: null };
    return this.writers.withLease([from, this.workspaces.threadPath(destination, project)], `moving thread ${id}`, async (lease) => {
      const moves = new ThreadMoves(this.db, this.workspaces);
      try {
        const moved = to === "worktree" ? await moves.toWorktree(thread, project, lease) : await moves.toCheckout(thread, project, lease, this.worktreeShared(thread));
        audit.record(this.db, { actor: "user", action: "thread.move", resourceType: "thread", resourceId: id, metadata: { to, files: moved.files } });
        return moved.thread;
      } finally {
        this.invalidate(["workspace-diff", "threads", "tasks", `thread:${id}`, `threaddiff:${id}`, `threadlog:${id}`]);
      }
    });
  }

  /** The files a move would carry, for its confirmation. */
  async movePreview(id: string, to: WorkspaceMode): Promise<ChangePreview> {
    const thread = this.thread(id);
    if (thread.projectId === WORKSPACE_ID) return { files: [], blocked: "Workspace conversations use their selected folder." };
    if (thread.workspaceMode === to) return { files: [], blocked: null };
    return new ThreadMoves(this.db, this.workspaces).preview(thread, executionProject(this.db, thread));
  }

  /* Compaction */

  /**
   * Codex compacts a live session in place. Claude Code has no such call in
   * print mode, so its threads get a fresh session seeded with a brief of the
   * conversation so far, which is what compaction amounts to. An idle Claude
   * process is closed by the fresh start.
   */
  async compact(id: string): Promise<void> {
    const thread = this.thread(id);
    const live = this.runs.liveRunForThread(id);
    if (live && this.runs.canCompact(live.id)) {
      try {
        await this.runs.compact(live.id);
      } finally {
        void this.messageQueue.drainQueue(id);
      }
      return;
    }
    if (live && this.runs.threadActivity(id) !== "idle") throw new Error("wait for the current turn to finish before compacting");
    const project = executionProject(this.db, thread);
    const own = runRepo.listForThread(this.db, id);
    if (own.length === 0) return;
    const brief = this.agentTools.handoffBrief(thread, own).replace(/^Handoff:.*$/m, `Compacted: this thread ("${thread.title}") continues from a summary. The full history stays in OpenOrc.`);
    await this.runs.start({
      scope: { task: null, thread },
      project,
      agent: thread.agent,
      model: thread.model ?? undefined,
      effort: thread.effort ?? undefined,
      fastMode: thread.fastMode,
      mode: thread.mode,
      permissionMode: thread.permissionMode,
      prompt: "The conversation was compacted. Acknowledge in one line and wait for the next instruction.",
      promptRole: "system",
      resume: false,
      handoff: brief,
    });
    audit.record(this.db, { actor: "user", action: "thread.compact", resourceType: "thread", resourceId: id });
    this.invalidate(["threads", `thread:${id}`]);
  }

  /* Queue */
  queueFollowUp(...args: Parameters<ThreadMessageQueue["queueFollowUp"]>) {
    return this.messageQueue.queueFollowUp(...args);
  }
  queue(...args: Parameters<ThreadMessageQueue["queue"]>) {
    return this.messageQueue.queue(...args);
  }
  recoverQueue(...args: Parameters<ThreadMessageQueue["recoverQueue"]>) {
    return this.messageQueue.recoverQueue(...args);
  }
  stopAccepting(...args: Parameters<ThreadMessageQueue["stopAccepting"]>) {
    return this.messageQueue.stopAccepting(...args);
  }
  shutdown(...args: Parameters<ThreadMessageQueue["shutdown"]>) {
    return this.messageQueue.shutdown(...args);
  }
  unqueue(...args: Parameters<ThreadMessageQueue["unqueue"]>) {
    return this.messageQueue.unqueue(...args);
  }
  sendQueued(...args: Parameters<ThreadMessageQueue["sendQueued"]>) {
    return this.messageQueue.sendQueued(...args);
  }
  send(...args: Parameters<ThreadMessageQueue["send"]>) {
    return this.messageQueue.send(...args);
  }
  /* Checkpoints */
  checkpoints(id: string): ThreadCheckpoint[] {
    return checkpoints.listForThread(this.db, id);
  }

  /** What restoring a checkpoint would change, for its confirmation. */
  async restorePreview(id: string, checkpointId: string): Promise<ChangePreview> {
    try {
      const { checkpoint, project, cwd } = await this.restoreTarget(id, checkpointId);
      return { files: fileChanges(await teamTransfer.treeDelta(project.rootPath, await treeHash(cwd), checkpoint.treeSha)), blocked: null };
    } catch (error) {
      return { files: [], blocked: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Puts the files back the way a checkpoint saved them: changes made since are undone and files created since are
   * deleted, through Git's own checkout, while staged changes stay staged. The files as they were first become a
   * checkpoint of their own, so a restore can itself be undone, and the restored state becomes the next one.
   */
  async restore(id: string, checkpointId: string): Promise<void> {
    if (this.runs.liveRunForThread(id)) throw new Error("end the current turn before restoring");
    const { thread, checkpoint, cwd } = await this.restoreTarget(id, checkpointId);
    await this.writers.withLease(cwd, `restoring thread ${id}`, async () => {
      const root = await realpath(cwd);
      const current = await treeHash(cwd);
      if (current === checkpoint.treeSha) return;
      const refs = checkpointRefs(id);
      const turn = checkpoints.listForThread(this.db, id).at(-1)?.turn ?? checkpoint.turn;
      const label = checkpoint.note ?? `turn ${checkpoint.turn}`;
      await pinObject(cwd, `${refs}${current}`, current);
      checkpoints.insert(this.db, { threadId: id, runId: null, turn, treeSha: current, diffStat: await diffStat(cwd, thread.baseSha), note: `Before restoring ${label}`, root });
      await switchFiles(cwd, current, checkpoint.treeSha);
      checkpoints.insert(this.db, { threadId: id, runId: null, turn, treeSha: checkpoint.treeSha, diffStat: await diffStat(cwd, thread.baseSha), note: `Restored ${label}`, root });
      audit.record(this.db, { actor: "user", action: "thread.restore", resourceType: "thread", resourceId: id, metadata: { checkpointId, treeSha: checkpoint.treeSha, before: current } });
      this.invalidate(["workspace-diff", `threaddiff:${id}`, `threadlog:${id}`, `checkpoints:${id}`, "threads", `thread:${id}`]);
    });
  }

  /** A checkpoint restores only into the folder it was read from, and only while Git still has its files. */
  private async restoreTarget(id: string, checkpointId: string) {
    const thread = this.thread(id);
    const checkpoint = checkpoints.get(this.db, checkpointId);
    if (!checkpoint || checkpoint.threadId !== id) throw new Error("checkpoint not found on this thread");
    const project = executionProject(this.db, thread);
    const cwd = thread.worktreePath ?? project.rootPath;
    if (checkpoint.root && checkpoint.root !== (await realpath(cwd))) {
      const checkout = await realpath(project.rootPath).catch(() => project.rootPath);
      const place = (folder: string) => (folder === checkout || folder === project.rootPath ? "the project checkout" : `a worktree at ${folder}`);
      throw new Error(`This checkpoint was saved in ${place(checkpoint.root)}, and the conversation now works in ${place(cwd)}. Move the conversation back to restore it.`);
    }
    if ((await git(cwd, ["cat-file", "-t", checkpoint.treeSha], { okCodes: [0, 128] })).stdout.trim() !== "tree")
      throw new Error("Git no longer has this checkpoint's files. It was saved before OpenOrc protected checkpoints from cleanup.");
    return { thread, checkpoint, project, cwd };
  }

  /* Tasks */
  assertTaskWorkspaceEditable(...args: Parameters<ThreadTaskExecution["assertTaskWorkspaceEditable"]>) {
    return this.taskExecution.assertTaskWorkspaceEditable(...args);
  }
  spawnTask(...args: Parameters<ThreadTaskExecution["spawnTask"]>) {
    return this.taskExecution.spawnTask(...args);
  }
  executionThreadFor(...args: Parameters<ThreadTaskExecution["executionThreadFor"]>) {
    return this.taskExecution.executionThreadFor(...args);
  }
  openTaskThread(...args: Parameters<ThreadTaskExecution["openTaskThread"]>) {
    return this.taskExecution.openTaskThread(...args);
  }
  taskThreadForStart(...args: Parameters<ThreadTaskExecution["taskThreadForStart"]>) {
    return this.taskExecution.taskThreadForStart(...args);
  }
  startTaskInThread(...args: Parameters<ThreadTaskExecution["startTaskInThread"]>) {
    return this.taskExecution.startTaskInThread(...args);
  }
  startTask(...args: Parameters<ThreadTaskExecution["startTask"]>) {
    return this.taskExecution.startTask(...args);
  }
  onTaskRunFinished(...args: Parameters<ThreadTaskExecution["onTaskRunFinished"]>) {
    return this.taskExecution.onTaskRunFinished(...args);
  }

  /* Agent-facing tools, scoped to the calling run */
  toolCreate(...args: Parameters<ThreadAgentTools["toolCreate"]>) {
    return this.agentTools.toolCreate(...args);
  }
  toolStart(...args: Parameters<ThreadAgentTools["toolStart"]>) {
    return this.agentTools.toolStart(...args);
  }
  toolList(...args: Parameters<ThreadAgentTools["toolList"]>) {
    return this.agentTools.toolList(...args);
  }
  toolGet(...args: Parameters<ThreadAgentTools["toolGet"]>) {
    return this.agentTools.toolGet(...args);
  }
  toolUpdate(...args: Parameters<ThreadAgentTools["toolUpdate"]>) {
    return this.agentTools.toolUpdate(...args);
  }
  toolThreadList(...args: Parameters<ThreadAgentTools["toolThreadList"]>) {
    return this.agentTools.toolThreadList(...args);
  }
  toolThreadRead(...args: Parameters<ThreadAgentTools["toolThreadRead"]>) {
    return this.agentTools.toolThreadRead(...args);
  }
  sourceThreadFor(...args: Parameters<ThreadAgentTools["sourceThreadFor"]>) {
    return this.agentTools.sourceThreadFor(...args);
  }
  toolThreadSend(...args: Parameters<ThreadAgentTools["toolThreadSend"]>) {
    return this.agentTools.toolThreadSend(...args);
  }

  /** For the run service: route a finished run to memory and, for tasks, back to the thread. */
  scopeThreadFor(...args: Parameters<ThreadTaskExecution["scopeThreadFor"]>) {
    return this.taskExecution.scopeThreadFor(...args);
  }
}
