import { orchestration, projects, taskForwardings, tasks, teamDeletedThreads, teamRoom, teamRuntime, teamTasks, threads } from "@openorc/db";
import {
  LeadOverrides,
  normalizeModelSettings,
  type ModelExecutionSettings,
  type TeamActorRecord,
  type TeamAttemptRecord,
  type TeamExecutionRecord,
  type TeamRevision,
  type Thread,
} from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import { type StartRunInput } from "./runs.js";
import { idle, participantId, type TeamCore } from "./team-core.js";

import type { TeamCoordinatorHooks, TeamStartPlan } from "./team-coordinator.js";
type StageServices = Pick<TeamCore, "db" | "runs" | "hooks" | "room" | "delivery" | "teamChat" | "scheduler" | "now" | "assertAccepting" | "assertGeneration" | "changed"> & {
  hooks: TeamCoordinatorHooks;
};
export class TeamModeDeferred extends Error {
  constructor() {
    super("This reservation is waiting for the team's requested mode before it can launch.");
  }
}

export interface TeamAdmissionInput {
  threadId: string;
  prompt: string;
  attachments?: string[];
  plan: TeamStartPlan;
  expectedConfigurationVersion?: number;
  admission?: TeamExecutionRecord["admission"];
  sourceTaskAdmissionId?: string;
  /** Participant actor ids the opening message addresses. Absent means the lead. */
  addressed?: string[];
  requestKey?: string;
}

export class TeamAttemptAdmission {
  constructor(private readonly services: StageServices) {}

  /** All ordinary run start paths share this guard, including queue drains and review follow-ups. */
  assertLaunch(input: StartRunInput): void {
    const forward = input.scope.task ? taskForwardings.target(this.services.db, input.scope.task.id) : null;
    if (forward && forward.state !== "ready") throw new Error("Finish this task’s saved handoff before starting an agent.");
    const threadId = input.scope.thread?.id ?? input.scope.task?.threadId;
    // A reserved attempt is coordinator-admitted work; the checks below prove it belongs to this thread's active execution.
    if (threadId) this.services.hooks.assertThreadAvailable?.(threadId, { retainedTask: Boolean(input.teamAttemptId) });
    if (!threadId || !orchestration.getInstance(this.services.db, threadId)) {
      this.assertUnrelatedScope(input);
      return;
    }
    const { record, attempt, actor } = this.reservedAttempt(input, threadId);
    this.services.assertGeneration(record, attempt.generation);
    this.assertReservedSession(input, attempt);
    this.assertReservedSettings(input, attempt);
    this.assertReservedMode(input, record, attempt, actor);
    // Permissions are adopted from the owning thread immediately before the
    // provider starts; unlike mode/settings they are not attempt reservations.
  }

  private assertUnrelatedScope(input: StartRunInput): void {
    if (input.scope.task && teamRuntime.assignmentsForTask(this.services.db, input.scope.task.id).length) throw new Error("Team task ownership no longer matches its conversation.");
    if (input.teamAttemptId) throw new Error("A team attempt cannot start in an unrelated scope.");
  }

  private reservedAttempt(input: StartRunInput, threadId: string): { record: TeamExecutionRecord; attempt: TeamAttemptRecord; actor: TeamActorRecord } {
    const record = teamRuntime.activeForThread(this.services.db, threadId);
    const attempt = record?.attempts.find((item) => item.id === input.teamAttemptId);
    const actor = record?.actors.find((item) => item.id === attempt?.actorId);
    if (!record || !attempt || !actor || attempt.state !== "starting" || actor.state !== "starting" || !this.ownsAttemptScope(input, record, actor))
      throw new Error("Team-owned work must start through its coordinator.");
    return { record, attempt, actor };
  }

  private ownsAttemptScope(input: StartRunInput, record: TeamExecutionRecord, actor: TeamActorRecord): boolean {
    if (!input.scope.task) return actor.id === "lead" || Boolean(actor.participant);
    return actor.taskId === input.scope.task.id && teamRuntime.assignment(this.services.db, record.id, actor.id)?.taskId === input.scope.task.id;
  }

  private assertReservedSession(input: StartRunInput, attempt: TeamAttemptRecord): void {
    const session = attempt.contextSessionId ?? attempt.resumeSessionId ?? null;
    if (input.resume || (input.resumeFrom?.sessionId ?? null) !== session || (input.resumeFrom && input.resumeFrom.fork !== false))
      throw new Error("Team runs must use only the provider session reserved for this attempt.");
  }

  private assertReservedSettings(input: StartRunInput, attempt: TeamAttemptRecord): void {
    const expectedSettings = normalizeModelSettings(attempt.settings);
    if (input.agent !== expectedSettings.agent || input.model !== expectedSettings.model || (input.effort ?? null) !== expectedSettings.effort || Boolean(input.fastMode) !== expectedSettings.fastMode)
      throw new Error("Team run settings must match the reserved attempt.");
  }

  private assertReservedMode(input: StartRunInput, record: TeamExecutionRecord, attempt: TeamAttemptRecord, actor: TeamActorRecord): void {
    const thread = threads.get(this.services.db, record.threadId)!;
    if (attempt.mode !== undefined && input.mode !== attempt.mode) throw new Error("The team run mode must match its reserved attempt.");
    if (input.mode !== thread.mode || (actor.taskId !== null && thread.mode !== "act")) throw new TeamModeDeferred();
  }

  async validateStart(input: { projectId: string; teamRevisionId: string; leadOverrides?: LeadOverrides; allowArchived?: boolean }): Promise<TeamStartPlan> {
    this.services.assertAccepting();
    const revision = orchestration.getRevision(this.services.db, input.teamRevisionId);
    if (!revision || revision.projectId !== input.projectId || !projects.get(this.services.db, input.projectId)) throw new Error("Team revision not found in this project.");
    if (!input.allowArchived && orchestration.get(this.services.db, revision.teamId)?.team.archivedAt !== null) throw new Error("An archived team cannot be selected for a new instance.");
    const lead = revision.members.find((member) => member.managerKey === null)!;
    const leadOverrides = LeadOverrides.parse(input.leadOverrides ?? {});
    const settings = normalizeModelSettings({ ...lead.settings, ...leadOverrides });
    if (leadOverrides.effort !== undefined) leadOverrides.effort = settings.effort;
    await Promise.all(revision.members.map((member) => this.services.hooks.validate(member.key === lead.key ? settings : normalizeModelSettings(member.settings), input.projectId)));
    this.services.assertAccepting();
    return { revision, settings, leadOverrides, ...(input.allowArchived ? { allowArchived: true } : {}) };
  }

  async validateLeadSettings(threadId: string, overrides: LeadOverrides): Promise<ModelExecutionSettings> {
    this.services.assertAccepting();
    const instance = orchestration.getInstance(this.services.db, threadId);
    const thread = threads.get(this.services.db, threadId);
    const revision = instance ? orchestration.getRevision(this.services.db, instance.teamRevisionId) : null;
    if (!thread || !revision || revision.projectId !== thread.projectId) throw new Error("This conversation has no pinned team revision.");
    const settings = normalizeModelSettings({ ...revision.members.find((member) => member.managerKey === null)!.settings, ...LeadOverrides.parse(overrides) });
    await this.services.hooks.validate(settings, thread.projectId);
    this.services.assertAccepting();
    return settings;
  }

  async start(input: { threadId: string; teamRevisionId?: string; initialLeadOverrides?: LeadOverrides; prompt: string; attachments?: string[] }): Promise<TeamExecutionRecord> {
    this.services.assertAccepting();
    this.services.hooks.assertThreadAvailable?.(input.threadId);
    const thread = threads.get(this.services.db, input.threadId);
    if (!thread) throw new Error("Thread not found.");
    if (!input.prompt.trim()) throw new Error("A team needs an instruction.");
    if (teamRuntime.activeForThread(this.services.db, thread.id)) throw new Error("This team already has unfinished work. Send direction or resolve its recovery state.");
    const instance = orchestration.getInstance(this.services.db, thread.id);
    if (instance && input.teamRevisionId && instance.teamRevisionId !== input.teamRevisionId) throw new Error("This thread is pinned to a different team revision.");
    const revisionId = instance?.teamRevisionId ?? input.teamRevisionId;
    if (!revisionId) throw new Error("Choose a saved team revision.");
    if (instance && input.initialLeadOverrides !== undefined) throw new Error("Initial lead overrides only apply when selecting a team for the first time.");
    const plan = await this.validateStart({
      projectId: thread.projectId,
      teamRevisionId: revisionId,
      leadOverrides: instance?.leadOverrides ?? input.initialLeadOverrides,
      allowArchived: Boolean(instance),
    });
    // Never authorize an old lead token in another execution, even when resuming its provider session.
    const previous = this.services.runs.liveRunForThread(thread.id);
    if (previous) {
      if (this.services.runs.threadActivity(thread.id) !== "idle") throw new Error("Wait for the current thread turn to finish before starting a team.");
      await this.services.runs.closeAndWait(previous.id, this.services.hooks.closeTimeoutMs);
      this.services.assertAccepting();
    }
    return this.admit({ ...input, plan, expectedConfigurationVersion: instance?.configurationVersion });
  }
  /** Synchronous admission composes with new-thread creation in the same transaction. */
  admit(input: TeamAdmissionInput): TeamExecutionRecord {
    this.services.assertAccepting();
    this.services.hooks.assertThreadAvailable?.(input.threadId, { retainedTask: Boolean(input.sourceTaskAdmissionId) });
    const thread = threads.get(this.services.db, input.threadId);
    const { revision } = input.plan;
    if (!thread || thread.projectId !== revision.projectId || !input.prompt.trim()) throw new Error("Team admission requires this project's thread and a nonempty instruction.");
    if (this.services.runs.liveRunForThread(thread.id)) throw new Error("The previous thread process must close before team admission.");
    const lead = revision.members.find((member) => member.managerKey === null)!;
    const now = this.services.now();
    const record = this.services.db.transaction(() => this.admitTransaction(input, thread, lead, now));
    this.services.scheduler.armDeadline(record);
    this.services.changed(record);
    this.services.scheduler.schedule();
    return record;
  }

  private admitTransaction(input: TeamAdmissionInput, thread: Thread, lead: TeamRevision["members"][number], now: number): TeamExecutionRecord {
    if (threads.get(this.services.db, thread.id)?.archivedAt !== null) throw new Error("Restore this archived team conversation before starting new work.");
    if (teamRuntime.activeForThread(this.services.db, thread.id)) throw new Error("This team started in another request.");
    let instance = orchestration.getInstance(this.services.db, thread.id);
    this.assertDeletedThreadAdmission(input, thread, instance);
    this.assertConfigurationUnchanged(input, instance);
    instance ??= orchestration.createInstance(
      this.services.db,
      { threadId: thread.id, teamRevisionId: input.plan.revision.id, initialLeadOverrides: input.plan.leadOverrides },
      { allowArchived: input.plan.allowArchived },
    );
    // Rebuild older room history before this execution is appended.
    this.services.room.ensureMigrated(instance.id);
    const addressed = input.addressed ?? [];
    const leadAddressed = addressed.length === 0 || addressed.includes("lead");
    const participants = this.participants(input.plan.revision, lead);
    if (addressed.some((id) => id !== "lead" && !participants.some((participant) => participant.id === id))) throw new Error("A message can address only members of this team.");
    const created = this.createExecution(input, thread, instance.id, lead, participants, leadAddressed, now);
    // The opening room entry is the lead's instruction and addressed members' chat.
    const opening = teamRoom.append(this.services.db, {
      instanceId: instance.id,
      authorKind: "user",
      authorId: "user",
      body: input.prompt,
      attachments: input.attachments ?? [],
      addressees: addressed.length ? addressed : ["lead"],
      executionId: created.id,
      source: "prompt",
      requestKey: this.openingRequestKey(input),
      createdAt: now,
    });
    const recipients = addressed.filter((id) => id !== "lead");
    const admitted = teamRuntime.update(this.services.db, created.id, (state) => {
      const chatId = randomUUID();
      for (const recipient of recipients)
        this.services.delivery.enqueueMessage(state, {
          senderId: "user",
          recipientId: recipient,
          kind: "chat",
          body: input.prompt,
          dedupeKey: `chat:user:${input.requestKey ?? chatId}:${recipient}`,
          attachments: input.attachments ?? [],
          chat: { chatId, to: addressed, roomEventId: opening.id },
        });
      this.services.teamChat.scheduleAmbient(state, opening, leadAddressed ? [...addressed, "lead"] : addressed);
    }).record;
    const settings = input.plan.settings;
    threads.update(this.services.db, thread.id, { agent: settings.agent, model: settings.model, effort: settings.effort, fastMode: settings.fastMode, doneAt: null, snoozedUntil: null });
    return admitted;
  }

  private assertDeletedThreadAdmission(input: TeamAdmissionInput, thread: Thread, instance: ReturnType<typeof orchestration.getInstance>): void {
    if (!teamDeletedThreads.has(this.services.db, thread.id)) return;
    const accepted = input.sourceTaskAdmissionId ? teamTasks.admission(this.services.db, input.sourceTaskAdmissionId) : null;
    if (
      !accepted ||
      accepted.instanceId !== instance?.id ||
      tasks.get(this.services.db, accepted.taskId)?.threadId !== thread.id ||
      input.admission?.scope !== "thread" ||
      input.admission.requestKey !== `task:${accepted.id}`
    )
      throw new Error("This conversation was deleted. Start or review one of its saved tasks to continue.");
  }

  private assertConfigurationUnchanged(input: TeamAdmissionInput, instance: ReturnType<typeof orchestration.getInstance>): void {
    if (
      instance &&
      (instance.configurationVersion !== input.expectedConfigurationVersion ||
        instance.teamRevisionId !== input.plan.revision.id ||
        JSON.stringify(instance.leadOverrides) !== JSON.stringify(input.plan.leadOverrides))
    )
      throw new Error("Team configuration changed during validation. Try again with the current settings.");
  }

  private participants(revision: TeamRevision, lead: TeamRevision["members"][number]): TeamActorRecord[] {
    return revision.members
      .filter((member) => member.managerKey !== null)
      .map((member) => ({
        id: participantId(member.key),
        memberKey: member.key,
        taskId: null,
        parentId: member.managerKey === lead.key ? "lead" : participantId(member.managerKey!),
        requestKey: null,
        requestHash: null,
        dependencies: [],
        participant: true,
        input: { title: member.name, spec: "", attachments: [], responsibility: member.responsibility, settings: member.settings },
        state: "waiting",
        retries: 0,
        directionVersion: 0,
        deliveredVersion: 0,
        disposition: idle(0),
        result: null,
        snapshotId: null,
        error: null,
      }));
  }

  private createExecution(
    input: TeamAdmissionInput,
    thread: Thread,
    instanceId: string,
    lead: TeamRevision["members"][number],
    participants: TeamActorRecord[],
    leadAddressed: boolean,
    now: number,
  ): TeamExecutionRecord {
    return teamRuntime.create(this.services.db, {
      id: randomUUID(),
      instanceId,
      threadId: thread.id,
      projectId: thread.projectId,
      ...(input.admission ? { admission: input.admission } : {}),
      state: "active",
      generation: 1,
      revision: 0,
      limits: input.plan.revision.limits,
      actors: [
        {
          id: "lead",
          memberKey: lead.key,
          taskId: null,
          parentId: null,
          requestKey: null,
          requestHash: null,
          dependencies: [],
          input: { title: thread.title, spec: input.prompt, attachments: input.attachments ?? [], responsibility: lead.responsibility, settings: input.plan.settings },
          state: leadAddressed ? "queued" : "waiting",
          retries: 0,
          directionVersion: 0,
          deliveredVersion: 0,
          disposition: leadAddressed ? null : idle(0),
          result: null,
          snapshotId: null,
          error: null,
        },
        ...participants,
      ],
      attempts: [],
      messages: [],
      error: null,
      createdAt: now,
      updatedAt: now,
      deadlineAt: now + input.plan.revision.limits.maxExecutionMinutes * 60_000,
    });
  }

  private openingRequestKey(input: TeamAdmissionInput): string | null {
    if (input.requestKey) return `prompt:${input.requestKey}`;
    if (input.admission) return `prompt:${input.admission.scope}:${input.admission.requestKey}`;
    return null;
  }
}
