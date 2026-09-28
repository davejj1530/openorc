import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  audit,
  orchestration,
  plans,
  projects,
  runs,
  tasks,
  teamContexts,
  teamDeletedThreads,
  teamForks,
  teamMoves,
  teamRestores,
  teamRoom,
  teamRuntime,
  teamWorkspaces,
  threads,
  type Db,
} from "@openorc/db";
import { git } from "@openorc/git";
import {
  MAX_TEAM_DEPTH,
  type RpcParams,
  type TeamActionAvailability,
  type TeamActorRecord,
  type TeamChatEntry,
  type TeamConversation,
  type TeamExecutionAvailability,
  type TeamExecutionRecord,
  type TeamExecutionView,
  type TeamMailboxMessage,
  type TeamRetainedTaskRuntime,
  type TeamRevision,
  type TeamRoomEvent,
  type Thread,
} from "@openorc/protocol";
import type { AppSettingsService } from "./settings.js";
import type { RunService } from "./runs.js";
import { TeamCoordinator } from "./team-coordinator.js";
import { titleFromPrompt } from "./threads.js";
import { teamMentions, selectedRecipients } from "./team-mentions.js";
import { relayTeamThreadMessage, type TeamThreadMessage } from "./team-thread-messages.js";
import type { TeamWorkspaceService } from "./team-workspaces.js";

const fingerprint = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

/** Internal callers can commit their launch receipt with the new conversation. */
export interface TeamStartAdmission {
  assertCanAdmit(): void;
  onAdmitted(thread: Thread, execution: TeamExecutionRecord): void;
  allowArchived?: boolean;
}

/** Local UI control boundary. Provider tools continue to use authenticated run bindings. */
export class TeamConversationService {
  constructor(
    private readonly db: Db,
    private readonly coordinator: TeamCoordinator,
    private readonly runs: RunService,
    private readonly settings: AppSettingsService,
    private readonly invalidate: (keys: string[]) => void,
    private readonly quiescenceReason: (threadId: string) => string | null,
    private readonly actions?: (threadId: string) => TeamConversation["actions"],
    /** Explicit setup/integration recovery; `available` reports pending fork/restore/move/delete fences. */
    private readonly recovery?: { workspaces: TeamWorkspaceService; available(threadId: string): string | null },
    private readonly enterImplementation?: (threadId: string) => void,
  ) {}

  private async resolveBase(projectId: string, ref: string): Promise<{ ref: string; sha: string }> {
    const project = projects.get(this.db, projectId);
    if (!project) throw new Error("Project not found.");
    if (ref.startsWith("-") || /[\s~^:?*[\\]/.test(ref)) throw new Error("The base must name a branch, tag or commit.");
    const resolved = await git(project.rootPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { okCodes: [0, 1] });
    if (resolved.code !== 0) throw new Error(`Base ${JSON.stringify(ref)} was not found in the project repository. Fetch it or choose another base.`);
    return { ref, sha: resolved.stdout.trim() };
  }

  availability(): TeamExecutionAvailability {
    const enabled = this.settings.get().experimentalTeamExecution;
    return { enabled, reason: enabled ? null : "Team execution is disabled. Enable Team execution (Beta) in Settings.", maxHierarchyDepth: MAX_TEAM_DEPTH };
  }
  private requireEnabled(): void {
    const availability = this.availability();
    if (!availability.enabled) throw new Error(availability.reason!);
  }

  async start(input: RpcParams<"threads.start">, internal?: TeamStartAdmission): Promise<{ thread: Thread; run: null }> {
    if (input.executionTarget?.kind !== "team") throw new Error("Choose a saved team.");
    if (!input.prompt.trim() || input.prompt.length > 100_000) throw new Error("A team needs an instruction of at most 100,000 characters.");
    const baseRef = input.baseRef?.trim();
    // Legacy/internal callers keep isolated startup; the composer sends its explicit choice.
    const workspaceMode = input.workspaceMode ?? "worktree";
    if (input.baseRef !== undefined && !baseRef) throw new Error("Choose a base branch or commit, or leave it empty to start from the project's current files.");
    if (baseRef && workspaceMode === "current") throw new Error("Local checkout uses the branch and files already checked out. Choose Worktree to start from a selected base.");
    const admission = input.requestKey
      ? {
          scope: "project" as const,
          requestKey: input.requestKey,
          payloadHash: fingerprint({
            projectId: input.projectId,
            target: input.executionTarget,
            mode: input.mode,
            permissionMode: input.permissionMode,
            workspaceMode: input.workspaceMode ?? null,
            prompt: input.prompt,
            attachments: input.attachments ?? [],
            title: input.title ?? null,
            ...(baseRef ? { baseRef } : {}),
          }),
        }
      : undefined;
    const replay = () => {
      if (!admission) return null;
      const previous = teamRuntime.findAdmission(this.db, { scope: "project", projectId: input.projectId, requestKey: admission.requestKey });
      if (!previous) return null;
      if (previous.admission!.payloadHash !== admission.payloadHash) throw new Error("This launch request key already identifies different work.");
      return this.db.transaction(() => {
        internal?.assertCanAdmit();
        const thread = threads.get(this.db, previous.threadId)!;
        internal?.onAdmitted(thread, previous);
        return { thread, run: null };
      });
    };
    const existing = replay();
    if (existing) return existing;
    internal?.assertCanAdmit();
    this.requireEnabled();
    const plan = await this.coordinator.validateStart({
      projectId: input.projectId,
      teamRevisionId: input.executionTarget.teamRevisionId,
      leadOverrides: input.executionTarget.initialLeadOverrides,
      allowArchived: internal?.allowArchived,
    });
    // A chosen base is pinned to one commit at admission; the lead's first workspace materializes exactly that tree.
    const base = baseRef ? await this.resolveBase(input.projectId, baseRef) : null;
    const concurrent = replay();
    if (concurrent) return concurrent;
    this.requireEnabled();
    // Setup happens after durable admission. If it fails, the returned task has
    // visible attention and its original request remains in the execution journal.
    const thread = this.db.transaction(() => {
      internal?.assertCanAdmit();
      const created = threads.insert(this.db, {
        projectId: input.projectId,
        title: input.title?.trim() || titleFromPrompt(input.prompt),
        ...plan.settings,
        mode: input.mode,
        permissionMode: input.permissionMode,
        workspaceMode,
      });
      audit.record(this.db, {
        actor: "user",
        action: "thread.create",
        resourceType: "thread",
        resourceId: created.id,
        metadata: { projectId: input.projectId, teamRevisionId: plan.revision.id, workspaceMode, ...(base ? { baseRef: base.ref, baseSha: base.sha } : {}) },
      });
      const seen = threads.update(this.db, created.id, { seenAt: Date.now(), ...(base ? { baseSha: base.sha } : {}) })!;
      // The opening message addresses members the same way later ones do: `@Name` wakes them, and the lead only when named or when nobody is.
      const mentioned = teamMentions(input.prompt, plan.revision.members);
      const addressed = mentioned.length ? this.addressees(plan.revision, mentioned) : null;
      const execution = this.coordinator.admit({
        threadId: created.id,
        prompt: input.prompt,
        attachments: input.attachments,
        plan,
        admission,
        ...(addressed ? { addressed: addressed.map((key) => (key === "lead" ? "lead" : `member:${key}`)), ...(input.requestKey ? { requestKey: input.requestKey } : {}) } : {}),
      });
      internal?.onAdmitted(seen, execution);
      return seen;
    });
    this.changed(thread.id);
    return { thread, run: null };
  }

  runtime(threadId: string): TeamConversation | null {
    if (!threads.get(this.db, threadId)) throw new Error("Thread not found.");
    const instance = orchestration.getInstance(this.db, threadId);
    if (!instance) return null;
    const revision = orchestration.getRevision(this.db, instance.teamRevisionId);
    if (!revision) throw new Error("The pinned team revision is missing. Preserve its history for recovery.");
    const rows = this.db.stmt("SELECT id FROM team_executions WHERE thread_id = ? ORDER BY created_at, rowid").all(threadId) as { id: string }[];
    const active = teamRuntime.activeForThread(this.db, threadId);
    const fork = teamForks.byDestinationThread(this.db, threadId);
    const restores = teamRestores.forThread(this.db, threadId).filter((item) => item.instanceId === instance.id && item.state === "applied");
    const restoreContexts = new Set(restores.map((item) => item.appliedContextId));
    const moves = teamMoves.forThread(this.db, threadId).filter((item) => item.instanceId === instance.id && item.state === "applied");
    const moveContexts = new Set(moves.map((item) => item.appliedContextId));
    // Deletion's internal boundary is provenance, not a user-visible compaction.
    const deletion = teamDeletedThreads.get(this.db, threadId);
    return {
      instance,
      revision,
      executions: rows.map((row) => this.project(this.coordinator.status(row.id))),
      actions: this.actions?.(threadId),
      policy: this.runs.threadPermissions(threadId),
      workspaceRestores: restores.map((item) => ({ id: item.id, checkpointId: item.checkpointId, sourceRunId: item.sourceRunId, createdAt: item.updatedAt })),
      workspaceMoves: moves.map((item) => ({ id: item.id, to: item.to, createdAt: item.updatedAt })),
      ...(fork
        ? {
            origin: {
              sourceThreadId: fork.sourceThreadId,
              sourceTitle: fork.thread.title,
              sourceExists: Boolean(threads.get(this.db, fork.sourceThreadId)) && !teamDeletedThreads.has(this.db, fork.sourceThreadId),
              sourceRunId: fork.sourceRunId,
              createdAt: fork.createdAt,
            },
          }
        : {}),
      steer: active ? this.coordinator.steerAvailability(active) : { allowed: false, reason: "The lead is not in an active turn." },
      context: {
        compact: this.compactAvailability(threadId),
        checkpoints: teamContexts
          .listForInstance(this.db, instance.id)
          .filter((item) => (!fork || item.requestKey !== `fork:${fork.id}`) && !restoreContexts.has(item.id) && !moveContexts.has(item.id) && item.id !== deletion?.contextCheckpointId)
          .map((item) => ({ id: item.id, actorId: item.actorId, executionId: item.originExecutionId, reason: item.reason, createdAt: item.createdAt })),
      },
    };
  }

  /**
   * A deleted conversation is controlled only through one of its surviving tasks.
   * The task must be this owner's own saved task; nothing else may resurrect it.
   */
  assertTaskScope(threadId: string, taskId?: string): void {
    const hidden = teamDeletedThreads.has(this.db, threadId);
    if (!taskId) {
      if (hidden) throw new Error("This conversation was deleted. Continue from one of its saved tasks.");
      return;
    }
    const task = tasks.get(this.db, taskId);
    const instance = orchestration.getInstance(this.db, threadId);
    if (!task || task.threadId !== threadId || !instance || threads.get(this.db, threadId)?.projectId !== task.projectId) throw new Error("This task does not belong to that team conversation.");
  }

  /** Read a deleted owner through its surviving task. Null while the owner is still an ordinary conversation. */
  taskRuntime(taskId: string): TeamRetainedTaskRuntime | null {
    const task = tasks.get(this.db, taskId);
    if (!task) return null;
    if (!task.threadId) return null;
    const deletion = teamDeletedThreads.get(this.db, task.threadId);
    if (!deletion) return null;
    this.assertTaskScope(task.threadId, taskId);
    const thread = threads.get(this.db, task.threadId);
    const runtime = thread && this.runtime(thread.id);
    if (!thread || !runtime || runtime.instance.id !== deletion.instanceId) throw new Error("The deleted conversation's team is missing. Preserve its history for recovery.");
    return { thread, runtime, deletedAt: deletion.deletedAt };
  }

  private requireRuntime(threadId: string): TeamConversation {
    const runtime = this.runtime(threadId);
    if (!runtime) throw new Error("This task does not have a saved team.");
    return runtime;
  }
  private ownedExecution(threadId: string, executionId: string): TeamExecutionRecord {
    this.requireRuntime(threadId);
    const execution = this.coordinator.status(executionId);
    if (execution.threadId !== threadId) throw new Error("This execution belongs to another task.");
    return execution;
  }

  async stop(input: RpcParams<"orchestration.stop">): Promise<TeamConversation> {
    this.ownedExecution(input.threadId, input.executionId);
    await this.coordinator.stop(input.executionId);
    return this.requireRuntime(input.threadId);
  }
  retry(input: RpcParams<"orchestration.retry">): TeamConversation {
    const execution = this.ownedExecution(input.threadId, input.executionId);
    const actor = execution.actors.find((item) => item.id === input.actorId);
    if (!actor) throw new Error("Assignment not found in this execution.");
    // A lost response can arrive after the retried actor has already finished.
    // Let the coordinator validate the retained operation before eligibility.
    const replay =
      input.fresh &&
      input.requestKey &&
      teamContexts.findRequest(this.db, {
        instanceId: execution.instanceId,
        executionId: actor.id === "lead" ? null : execution.id,
        actorId: actor.id,
        requestKey: input.requestKey,
      });
    if (!replay) {
      const availability = this.retryAvailability(execution, actor);
      if (!availability.allowed) throw new Error(availability.reason!);
    }
    this.coordinator.retry(execution.id, actor.id, { fresh: input.fresh, requestKey: input.requestKey });
    return this.requireRuntime(input.threadId);
  }

  compact(input: RpcParams<"orchestration.compact">): TeamConversation {
    const instance = orchestration.getInstance(this.db, input.threadId);
    if (!instance) throw new Error("This task does not have a saved team.");
    const replay = teamContexts.findRequest(this.db, { instanceId: instance.id, executionId: null, actorId: "lead", requestKey: input.requestKey });
    if (!replay) {
      const availability = this.compactAvailability(input.threadId);
      if (!availability.allowed) throw new Error(availability.reason!);
    }
    this.coordinator.compact(input.threadId, input.requestKey);
    this.changed(input.threadId);
    return this.requireRuntime(input.threadId);
  }

  private compactAvailability(threadId: string): TeamActionAvailability {
    if (threads.get(this.db, threadId)?.archivedAt) return { allowed: false, reason: "Unarchive this team task before compacting its context." };
    const reason = this.quiescenceReason(threadId);
    if (reason) return { allowed: false, reason };
    try {
      this.coordinator.assertQuiescent(threadId);
      return { allowed: true, reason: null };
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  cancelDirection(input: RpcParams<"orchestration.cancelDirection">): TeamConversation {
    this.ownedExecution(input.threadId, input.executionId);
    this.coordinator.cancelDirection(input.executionId, input.messageId);
    return this.requireRuntime(input.threadId);
  }
  sendNow(input: RpcParams<"orchestration.sendNow">): TeamConversation {
    this.ownedExecution(input.threadId, input.executionId);
    this.coordinator.sendNow(input.executionId, input.messageId);
    return this.requireRuntime(input.threadId);
  }
  async implementPlan(input: RpcParams<"orchestration.implementPlan">): Promise<TeamConversation> {
    this.assertTaskScope(input.threadId);
    const plan = plans.list(this.db, input.threadId)[0];
    const binding = plan && teamRuntime.binding(this.db, plan.runId);
    if (!plan || plan.id !== input.planId || plan.source !== "native" || plan.state !== "ready" || !plan.text.trim() || binding?.actorId !== "lead")
      throw new Error("Review the latest completed plan from the team lead first.");
    return this.send(
      {
        threadId: input.threadId,
        requestKey: `plan.implementation:${plan.id}`,
        text: `Implement the approved team plan, revision ${plan.revision} (${plan.id}). Keep the team's configured permissions and coordinate the work through this team.\n\n${plan.text}`,
      },
      () => {
        // Recheck after asynchronous readiness validation, before changing mode
        // or admitting direction. The transaction also makes a lost reply replayable.
        const latest = plans.list(this.db, input.threadId)[0];
        if (latest?.id !== plan.id || latest.state !== "ready") throw new Error("The plan changed. Review the latest completed revision first.");
        const active = teamRuntime.activeForThread(this.db, input.threadId);
        if (active && (active.state !== "active" || active.actors.some((actor) => actor.state === "starting") || active.attempts.some((attempt) => attempt.runId && this.runs.isBusy(attempt.runId))))
          throw new Error("Wait for the team's current turns to finish and resolve any pending recovery before implementing the plan.");
        if (active && this.runs.pending().some((approval) => active.attempts.some((attempt) => attempt.runId === approval.runId)))
          throw new Error("Resolve the team's pending approvals before implementing the plan.");
        if (!this.enterImplementation) throw new Error("Team plan implementation is unavailable.");
        this.enterImplementation(input.threadId);
        audit.record(this.db, { actor: "user", action: "plan.implement", resourceType: "thread", resourceId: input.threadId, metadata: { planId: plan.id, revision: plan.revision, team: true } });
      },
    );
  }

  async send(input: RpcParams<"orchestration.send">, beforePlanImplementation?: () => void): Promise<TeamConversation> {
    const runtime = this.requireRuntime(input.threadId);
    const attachments = [...new Set(input.attachments ?? [])];
    // Preserve existing admission keys exactly; mailbox direction normalizes
    // duplicate image references before reserving a turn.
    const delivery = input.now ? { delivery: "immediate" as const } : {};
    // Mentions in the text address members; explicit `to` still works for callers. Without either the message is lead direction, as before.
    const mentioned = beforePlanImplementation ? [] : teamMentions(input.text, runtime.revision.members);
    const to = selectedRecipients(input.to, mentioned);
    const addressed = to ? this.addressees(runtime.revision, to) : null;
    const payloadHash = fingerprint({ text: input.text, attachments: input.attachments ?? [], ...delivery, ...(to ? { to } : {}) });
    const directionHash = fingerprint({ text: input.text, attachments, ...delivery });
    const replayed = () => {
      const previous = teamRuntime.findAdmission(this.db, { scope: "thread", threadId: input.threadId, requestKey: input.requestKey });
      if (previous) {
        if (previous.admission!.payloadHash !== payloadHash) throw new Error("This message request key already identifies different work.");
        return true;
      }
      const chat = teamRuntime.findUserChat(this.db, input.threadId, input.requestKey);
      if (chat) {
        const first = chat.messages[0]!;
        if (
          !to ||
          fingerprint({ text: first.body, attachments: [...new Set(first.attachments ?? [])], to: [...(first.to ?? [])].sort() }) !==
            fingerprint({ text: input.text, attachments, to: [...addressed!].sort() })
        )
          throw new Error("This message request key already identifies a different message.");
        return true;
      }
      const direction = teamRuntime.findUserDirection(this.db, input.threadId, input.requestKey);
      if (!direction) return false;
      if (
        to ||
        fingerprint({
          text: direction.message.body,
          attachments: [...new Set(direction.message.attachments ?? [])],
          ...(direction.message.delivery ? { delivery: direction.message.delivery } : {}),
        }) !== directionHash
      )
        throw new Error("This message request key already identifies different direction.");
      return true;
    };
    if (replayed()) return this.requireRuntime(input.threadId);
    if (threads.get(this.db, input.threadId)?.archivedAt) throw new Error("Unarchive this team task before sending new work.");
    const active = teamRuntime.activeForThread(this.db, input.threadId);
    if (!active && teamDeletedThreads.has(this.db, input.threadId)) throw new Error("This conversation was deleted. Start or review the saved task to continue its team.");
    if (active) {
      this.db.transaction(() => {
        beforePlanImplementation?.();
        if (addressed) this.coordinator.chat(active.id, { text: input.text, to: addressed, requestKey: input.requestKey, attachments, now: input.now });
        else this.coordinator.steer(active.id, { text: input.text, attachments, requestKey: input.requestKey, now: input.now });
        threads.update(this.db, input.threadId, { doneAt: null, snoozedUntil: null });
      });
    } else {
      this.requireEnabled();
      const plan = await this.coordinator.validateStart({
        projectId: runtime.revision.projectId,
        teamRevisionId: runtime.revision.id,
        leadOverrides: runtime.instance.leadOverrides,
        allowArchived: true,
      });
      if (replayed()) return this.requireRuntime(input.threadId);
      this.requireEnabled();
      this.db.transaction(() => {
        beforePlanImplementation?.();
        this.coordinator.admit({
          threadId: input.threadId,
          prompt: input.text,
          attachments,
          plan,
          expectedConfigurationVersion: runtime.instance.configurationVersion,
          admission: { scope: "thread", requestKey: input.requestKey, payloadHash },
          ...(addressed ? { addressed: addressed.map((key) => (key === "lead" ? "lead" : `member:${key}`)), requestKey: input.requestKey } : {}),
        });
      });
    }
    this.runs.noteAgentMessage(input.threadId, 0);
    this.changed(input.threadId);
    return this.requireRuntime(input.threadId);
  }
  /**
   * Queue a message from another thread of the same project for the lead. Only a
   * running execution accepts it: another agent's message never starts a team.
   */
  relay(input: TeamThreadMessage): TeamMailboxMessage {
    const message = relayTeamThreadMessage(this.db, this.coordinator, input);
    this.changed(input.threadId);
    return message;
  }

  /** Member and team names for a team-bound sender run; null for ordinary runs. */
  senderAttribution(runId: string): { threadId: string; member: string; team: string } | null {
    const binding = this.coordinator.binding(runId);
    if (!binding) return null;
    const record = teamRuntime.get(this.db, binding.executionId);
    const actor = record?.actors.find((item) => item.id === binding.actorId);
    const instance = record ? orchestration.getInstance(this.db, record.threadId) : null;
    const revision = instance ? orchestration.getRevision(this.db, instance.teamRevisionId) : null;
    if (!record || !actor || !revision) return null;
    return { threadId: record.threadId, member: revision.members.find((member) => member.key === actor.memberKey)?.name ?? actor.memberKey, team: revision.name };
  }

  async configureLead(input: RpcParams<"orchestration.configureLead">): Promise<TeamConversation> {
    const { instance } = this.requireRuntime(input.threadId);
    const settings = await this.coordinator.validateLeadSettings(input.threadId, input.leadOverrides);
    input = { ...input, leadOverrides: { ...input.leadOverrides, ...(input.leadOverrides.effort !== undefined ? { effort: settings.effort } : {}) } };
    this.db.transaction(() => {
      const updated = orchestration.updateLeadOverrides(this.db, { ...input, expectedConfigurationVersion: instance.configurationVersion });
      threads.update(this.db, input.threadId, { effort: settings.effort, fastMode: settings.fastMode });
      if (updated.configurationVersion !== instance.configurationVersion)
        audit.record(this.db, {
          actor: "user",
          action: "team.lead_settings",
          resourceType: "thread",
          resourceId: input.threadId,
          metadata: { configurationVersion: updated.configurationVersion, effort: settings.effort, fastMode: settings.fastMode },
        });
    });
    this.changed(input.threadId);
    return this.requireRuntime(input.threadId);
  }

  private retryAvailability(execution: TeamExecutionRecord, actor: TeamActorRecord): TeamActionAvailability {
    const coordinator = this.coordinator.retryAvailability(execution, actor.id);
    if (!coordinator.allowed) return coordinator;
    const workspace = teamWorkspaces.get(this.db, execution.id, actor.id);
    if (workspace && (workspace.state !== "ready" || workspace.setupState !== "completed"))
      return {
        allowed: false,
        reason: workspace.error ?? "Workspace setup needs recovery. Retry setup in a new directory or accept its changes; retained files are never overwritten.",
      };
    for (const publication of teamWorkspaces.publications(this.db, execution.id)) {
      if (publication.targetActorId !== actor.id && publication.targetActorId !== actor.parentId) continue;
      if (publication.state === "conflict")
        return { allowed: false, reason: publication.error ?? "Conflicting output needs resolution in its retained scratch workspace. Resolve and accept it, or retry the integration." };
      if (publication.state !== "applied" && !publication.afterTree && existsSync(publication.scratchPath))
        return { allowed: false, reason: "Interrupted scratch integration needs an explicit integration retry; its evidence was preserved." };
    }
    return coordinator;
  }

  /** Recovery reads share the coordinator's idle checks; pending workspace operations fence them like other mutations. */
  private recoveryContext(execution: TeamExecutionRecord) {
    const context = this.coordinator.recoveryContext(execution);
    const fence = this.recovery?.available(execution.threadId) ?? null;
    return {
      assertActive: () => {
        if (fence) throw new Error(fence);
        context.assertActive();
      },
      assertActorIdle: (actorId: string) => {
        if (fence) throw new Error(fence);
        context.assertActorIdle(actorId);
      },
    };
  }

  async retrySetup(input: RpcParams<"orchestration.workspace.retrySetup">): Promise<TeamConversation> {
    const execution = this.ownedExecution(input.threadId, input.executionId);
    if (!this.recovery) throw new Error("Workspace recovery is unavailable in this app instance.");
    try {
      await this.recovery.workspaces.retrySetup(execution.id, input.actorId, input.requestKey, this.recoveryContext(execution));
    } finally {
      this.changed(input.threadId);
    }
    return this.requireRuntime(input.threadId);
  }
  async acceptSetup(input: RpcParams<"orchestration.workspace.acceptSetup">): Promise<TeamConversation> {
    const execution = this.ownedExecution(input.threadId, input.executionId);
    if (!this.recovery) throw new Error("Workspace recovery is unavailable in this app instance.");
    try {
      await this.recovery.workspaces.acceptSetup(execution.id, input.actorId, input.requestKey, this.recoveryContext(execution));
    } finally {
      this.changed(input.threadId);
    }
    return this.requireRuntime(input.threadId);
  }
  async retryIntegration(input: RpcParams<"orchestration.integration.retry">): Promise<TeamConversation> {
    const execution = this.ownedExecution(input.threadId, input.executionId);
    if (!this.recovery) throw new Error("Workspace recovery is unavailable in this app instance.");
    try {
      await this.recovery.workspaces.retryIntegration(execution.id, input.publicationId, input.requestKey, this.recoveryContext(execution));
    } finally {
      this.changed(input.threadId, { checkout: true });
    }
    return this.requireRuntime(input.threadId);
  }
  async acceptIntegration(input: RpcParams<"orchestration.integration.accept">): Promise<TeamConversation> {
    const execution = this.ownedExecution(input.threadId, input.executionId);
    if (!this.recovery) throw new Error("Workspace recovery is unavailable in this app instance.");
    try {
      await this.recovery.workspaces.acceptIntegration(execution.id, input.publicationId, input.requestKey, this.recoveryContext(execution));
    } finally {
      this.changed(input.threadId, { checkout: true });
    }
    return this.requireRuntime(input.threadId);
  }

  /** Member keys, "lead" or "all" resolved against the saved roster; the coordinator resolves them to actors again at delivery. */
  private addressees(revision: TeamRevision, to: readonly string[]): string[] {
    const keys = new Set<string>();
    for (const key of to) {
      if (key === "all" || key === "everyone") {
        for (const member of revision.members) keys.add(member.managerKey === null ? "lead" : member.key);
        continue;
      }
      const member = revision.members.find((item) => item.key === key || (key === "lead" && item.managerKey === null));
      if (!member) throw new Error(`No team member is addressed by ${JSON.stringify(key)}.`);
      keys.add(member.managerKey === null ? "lead" : member.key);
    }
    return [...keys];
  }

  private project(execution: TeamExecutionRecord): TeamExecutionView {
    const readers = teamRoom.readers(this.db, execution.instanceId, execution.id);
    const room = teamRoom.forExecution(this.db, execution.instanceId, execution.id);
    const revision = orchestration.getRevision(this.db, orchestration.getInstance(this.db, execution.threadId)!.teamRevisionId);
    const seenBy = (eventId: string | undefined, delivered: string[] = []) =>
      execution.actors
        .filter((actor) => actor.taskId === null && (readers.get(eventId ?? "")?.includes(actor.id) || delivered.includes(actor.id)))
        .map((actor) => ({ actorId: actor.id, name: revision?.members.find((member) => member.key === actor.memberKey)?.name ?? actor.memberKey }));
    const planning = ["active", "attention"].includes(execution.state) && threads.get(this.db, execution.threadId)?.mode === "plan";
    const actors = execution.actors.map((actor) => {
      const attempts = execution.attempts.filter((item) => item.actorId === actor.id);
      const runIds = [...new Set(attempts.flatMap((item) => (item.runId ? [item.runId] : [])))];
      const workspace = teamWorkspaces.get(this.db, execution.id, actor.id);
      const retry = this.retryAvailability(execution, actor);
      const delegatedBy = this.delegatingTurn(execution, actor);
      return {
        id: actor.id,
        memberKey: actor.memberKey,
        taskId: actor.taskId,
        parentId: actor.parentId,
        ...(actor.participant ? { participant: true as const } : {}),
        ...(delegatedBy ? { dispatchedBy: delegatedBy } : {}),
        ...(planning && ((actor.modeHold === "plan" && actor.state === "waiting") || (actor.taskId !== null && actor.state === "queued")) ? { modeHold: "plan" as const } : {}),
        title: actor.input.title,
        createdAt: (actor.taskId ? tasks.get(this.db, actor.taskId)?.createdAt : null) ?? execution.createdAt,
        waitReason: this.coordinator.activityReason(execution, actor),
        state: actor.state,
        settings: attempts.at(-1)?.settings ?? actor.input.settings,
        runIds,
        // A process's own start time belongs to its first turn; a later turn on it began when it was reserved.
        runs: attempts.flatMap((attempt) =>
          attempt.runId
            ? [
                {
                  id: attempt.runId,
                  turnId: attempt.id,
                  turn: attempt.processTurn ?? 0,
                  settings: attempt.settings,
                  startedAt: attempt.processTurn ? attempt.createdAt : (runs.get(this.db, attempt.runId)?.startedAt ?? attempt.createdAt),
                  endedAt: attempt.endedAt,
                  ...(attempt.changedFiles ? { changedFiles: attempt.changedFiles } : {}),
                  ...(attempt.reason ? { reason: attempt.reason } : {}),
                  ...(attempt.outcome === "silent" ? { silent: true } : {}),
                },
              ]
            : [],
        ),
        claims: (execution.claims ?? [])
          .filter((claim) => claim.actorId === actor.id && claim.releasedAt === null)
          .map((claim) => ({ path: claim.path, note: claim.note, createdAt: claim.createdAt })),
        // A member's session stays open between turns, so working means a turn is actually in flight.
        activeRunId: runIds.findLast((id) => this.runs.isBusy(id)) ?? null,
        error: actor.error,
        result: actor.result,
        retry,
        freshRetry: retry,
        workspace: workspace
          ? {
              path: workspace.path,
              state: workspace.state,
              setupState: workspace.setupState,
              error: workspace.error,
              outputAvailable: Boolean(workspace.outputTree),
              ...(this.recovery
                ? (() => {
                    const recovery = this.recovery!.workspaces.setupRecovery(execution.id, actor.id, this.recoveryContext(execution));
                    return recovery ? { recovery } : {};
                  })()
                : {}),
            }
          : null,
      };
    });
    const working = execution.state === "stopping" || actors.some((actor) => actor.activeRunId || (!actor.modeHold && ["queued", "starting", "running"].includes(actor.state)));
    const modeHeld = actors.some((actor) => actor.modeHold);
    const executionRuns = new Set(actors.flatMap((actor) => actor.runIds));
    const needsApproval = execution.state !== "stopping" && this.runs.pending().some((approval) => executionRuns.has(approval.runId));
    // A step that failed is shown where the work is; the execution is skipped until its next change.
    const fault = this.coordinator.faultReason(execution.id);
    const chat = this.chatEntries(execution, readers, room);
    const opening = room.find((event) => event.source === "prompt");
    return {
      id: execution.id,
      state: execution.state,
      generation: execution.generation,
      createdAt: execution.createdAt,
      updatedAt: execution.updatedAt,
      error: fault ?? execution.error,
      activity: executionActivity({ state: execution.state, fault, needsApproval, working, modeHeld }),
      initialPrompt: {
        text: execution.actors[0]!.input.spec,
        attachments: execution.actors[0]!.input.attachments,
        createdAt: execution.createdAt,
        seenBy: seenBy(opening?.id),
        ...(() => {
          const chatId = this.openingChat(execution, chat, opening);
          return chatId ? { chatId } : {};
        })(),
      },
      userDirections: execution.messages
        .filter((item) => (item.senderId === "user" || item.senderId.startsWith("thread:")) && item.kind === "direction")
        .map((item) => {
          const attempt = execution.attempts.find((candidate) => candidate.liveDirections?.some((receipt) => receipt.messageId === item.id));
          const receipt = attempt?.liveDirections?.find((candidate) => candidate.messageId === item.id);
          const sourceThreadId = item.senderId.startsWith("thread:") ? item.senderId.slice("thread:".length) : null;
          return {
            id: item.id,
            seenBy: seenBy(item.roomEventId, item.state === "delivered" ? [item.recipientId] : []),
            text: item.body,
            createdAt: item.createdAt,
            attachments: item.attachments ?? [],
            state: item.state,
            ...(item.state === "pending"
              ? {
                  waitReason: this.coordinator.steerAvailability(execution, item.recipientId).reason ?? "Queued for the next turn.",
                  sendNow: this.coordinator.sendNowAvailability(execution, item.id),
                }
              : {}),
            ...(sourceThreadId ? { from: { threadId: sourceThreadId, title: threads.get(this.db, sourceThreadId)?.title ?? null } } : {}),
            ...(attempt?.runId && receipt && receipt.state !== "unavailable" ? { live: { runId: attempt.runId, state: receipt.state } } : {}),
            cancel: item.state === "cancelled" ? { allowed: false, reason: "This message is already cancelled." } : this.coordinator.cancelDirectionAvailability(execution, item.id),
          };
        }),
      actors,
      chat: chat.map(({ entry, roomEventId }) => ({
        ...entry,
        seenBy: seenBy(
          roomEventId,
          entry.to.filter((recipient) => recipient.state === "delivered").map((recipient) => recipient.actorId),
        ),
      })),
      publications: teamWorkspaces.publications(this.db, execution.id).map((item) => ({
        id: item.id,
        sourceActorId: item.sourceActorId,
        targetActorId: item.targetActorId,
        state: item.state,
        scratchPath: item.scratchPath,
        error: item.error,
        ...(this.recovery
          ? (() => {
              const recovery = this.recovery!.workspaces.integrationRecovery(item, this.recoveryContext(execution));
              return recovery ? { recovery } : {};
            })()
          : {}),
      })),
    };
  }
  /**
   * The chat entry that carries the opening message, when it was addressed to members. An execution older than the room
   * log has no opening event; the rule the room migration used identifies its opening message instead.
   */
  private openingChat(execution: TeamExecutionRecord, chat: readonly { entry: TeamChatEntry; roomEventId: string | undefined }[], opening: TeamRoomEvent | undefined): string | undefined {
    if (opening) return chat.find((item) => item.roomEventId === opening.id)?.entry.id;
    const spec = execution.actors[0]!.input.spec;
    return chat.find(({ entry }) => entry.senderId === "user" && entry.text === spec && entry.createdAt <= execution.createdAt + 5_000)?.entry.id;
  }

  /** The manager's turn that delegated an assignment. Older journals place it with the manager's turn before its first turn. */
  private delegatingTurn(execution: TeamExecutionRecord, actor: TeamActorRecord): string | undefined {
    if (actor.participant || actor.parentId === null) return undefined;
    if (actor.dispatchedBy) return actor.dispatchedBy;
    const first = execution.attempts.find((attempt) => attempt.actorId === actor.id);
    return execution.attempts.findLast((attempt) => attempt.actorId === actor.parentId && (!first || attempt.createdAt <= first.createdAt))?.id;
  }

  private chatEntries(execution: TeamExecutionRecord, readers: ReadonlyMap<string, string[]>, room: readonly TeamRoomEvent[]): { entry: TeamChatEntry; roomEventId: string | undefined }[] {
    const revision = orchestration.getRevision(this.db, orchestration.getInstance(this.db, execution.threadId)!.teamRevisionId);
    const name = (id: string): string => {
      if (id === "user") return "You";
      if (id.startsWith("thread:")) return threads.get(this.db, id.slice("thread:".length))?.title ?? "Another thread";
      const actor = execution.actors.find((item) => item.id === id);
      return revision?.members.find((member) => member.key === actor?.memberKey)?.name ?? actor?.input.title ?? id;
    };
    const grouped = new Map<string, { entry: TeamChatEntry; roomEventId: string | undefined }>();
    for (const message of execution.messages) {
      if (message.kind !== "chat") continue;
      const id = message.chatId ?? message.id;
      const attempt = execution.attempts.find((candidate) => candidate.liveDirections?.some((receipt) => receipt.messageId === message.id));
      const receipt = attempt?.liveDirections?.find((candidate) => candidate.messageId === message.id);
      const entry: TeamChatEntry = grouped.get(id)?.entry ?? {
        id,
        senderId: message.senderId,
        senderName: name(message.senderId),
        text: message.body,
        attachments: message.attachments ?? [],
        createdAt: message.createdAt,
        to: [],
      };
      entry.to.push({
        actorId: message.recipientId,
        name: name(message.recipientId),
        state: message.state,
        ...(message.state === "pending" ? { waitReason: this.coordinator.steerAvailability(execution, message.recipientId).reason ?? "Queued for the next turn." } : {}),
        ...(receipt && receipt.state !== "unavailable" ? { live: receipt.state } : {}),
      });
      grouped.set(id, { entry, roomEventId: message.roomEventId });
    }
    // A member addressed to read rather than answer holds no mailbox message: the room records the message and its reading.
    const byEvent = new Map([...grouped.values()].flatMap((item) => (item.roomEventId ? [[item.roomEventId, item] as const] : [])));
    for (const event of room) {
      if (event.source !== "say") continue;
      const item = byEvent.get(event.id) ?? {
        entry: { id: event.id, senderId: event.authorId, senderName: name(event.authorId), text: event.body, attachments: event.attachments, createdAt: event.createdAt, to: [] },
        roomEventId: event.id,
      };
      for (const actorId of event.addressees) {
        if (item.entry.to.some((recipient) => recipient.actorId === actorId)) continue;
        const read = readers.get(event.id)?.includes(actorId) ?? false;
        item.entry.to.push({ actorId, name: name(actorId), state: read ? "delivered" : "pending", ...(read ? {} : { waitReason: "Reads it on their next turn." }) });
      }
      grouped.set(item.entry.id, item);
    }
    return [...grouped.values()].sort((a, b) => a.entry.createdAt - b.entry.createdAt);
  }
  /** `checkout` when the work may have written a shared checkout, whose diffs are not polled. */
  private changed(threadId: string, options: { checkout?: boolean } = {}): void {
    this.invalidate([...(options.checkout ? ["workspace-diff"] : []), "orchestration", "threads", `thread:${threadId}`]);
  }
}

/** Faults and approvals take precedence over ordinary work and mode-held activity. */
function executionActivity({
  state,
  fault,
  needsApproval,
  working,
  modeHeld,
}: {
  state: TeamExecutionRecord["state"];
  fault: string | null;
  needsApproval: boolean;
  working: boolean;
  modeHeld: boolean;
}): TeamExecutionView["activity"] {
  if (fault) return "attention";
  if (needsApproval) return "waiting";
  if (working) return "working";
  if (state === "attention") return "attention";
  if (state === "active") return modeHeld ? "waiting" : "working";
  return "idle";
}
