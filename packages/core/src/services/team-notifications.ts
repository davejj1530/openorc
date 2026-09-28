import { createHash } from "node:crypto";
import { orchestration, teamDeletedThreads, teamNotifications, teamRuntime, teamTasks, threads, type Db } from "@openorc/db";
import type { AgentEvent, TeamActorRecord, TeamExecutionRecord } from "@openorc/protocol";
import type { Notification, RunService } from "./runs.js";

type ApprovalEvent = Extract<AgentEvent, { type: "approval.requested" }>;
type Notice = Omit<Notification, "type">;

/** Logical team outcomes and real permission waits; provider turns are deliberately ignored. */
export class TeamNotificationService {
  private active = false;

  constructor(
    private readonly db: Db,
    private readonly runs: Pick<RunService, "pending">,
    private readonly notify: (notice: Notice) => void,
  ) {}

  /** A journal that cannot be read gets no baseline here; the coordinator reports it and it never blocks startup. */
  baselineAfterRecovery(): void {
    for (const id of teamRuntime.openIds(this.db)) {
      try {
        const record = teamRuntime.get(this.db, id);
        if (record) this.claimAttention(record);
      } catch {
        // Reported by TeamCoordinator.recover.
      }
    }
    this.active = true;
  }

  shutdown(): void {
    this.active = false;
  }

  observe(input: TeamExecutionRecord): void {
    if (!this.active) return;
    const record = teamRuntime.get(this.db, input.id);
    if (!record || record.threadId !== input.threadId || record.instanceId !== input.instanceId) return;
    const thread = threads.get(this.db, record.threadId);
    if (!thread) return;
    const target = this.target(record, null);
    if (record.state === "completed") {
      const id = `finished:${record.id}`;
      if (!teamNotifications.claim(this.db, { id, executionId: record.id, createdAt: Date.now() })) return;
      this.notify({
        id,
        executionId: record.id,
        actorId: "lead",
        kind: "finished",
        ...target,
        title: thread.title,
        body: clip(record.actors.find((actor) => actor.id === "lead")?.result ?? "The team finished its work."),
      });
    } else if (record.state === "attention") {
      const fresh = this.claimAttention(record);
      if (!fresh.length) return;
      const actor = fresh.length === 1 ? record.actors.find((item) => item.id === fresh[0]!.actorId) : undefined;
      const cause = fresh
        .map((item) => item.id)
        .sort()
        .join("\n");
      const id = `attention:${record.id}:${createHash("sha256").update(cause).digest("hex")}`;
      this.notify({
        id,
        executionId: record.id,
        ...(actor ? { actorId: actor.id } : {}),
        kind: "error",
        ...this.target(record, actor?.taskId ?? null),
        title: thread.title,
        body: actor
          ? `${this.memberName(record, actor)} needs attention. ${clip(actor.error ?? record.error ?? "Review its recovery details.")}`
          : "The team needs attention. Review its recovery details.",
      });
    }
  }

  /** A deleted owner is never a destination; route its lead activity to the saved task that admitted the execution. */
  private target(record: TeamExecutionRecord, taskId: string | null): { threadId: string | null; taskId: string | null } {
    if (!teamDeletedThreads.has(this.db, record.threadId)) return { threadId: record.threadId, taskId };
    const admitted = taskId ?? teamTasks.admittingTask(this.db, record.id);
    return { threadId: null, taskId: admitted };
  }

  approval(event: ApprovalEvent): void {
    if (!this.active || !this.runs.pending().some((item) => item.runId === event.runId && item.approvalId === event.approvalId)) return;
    const binding = teamRuntime.binding(this.db, event.runId);
    if (!binding) return;
    const record = teamRuntime.get(this.db, binding.executionId);
    const actor = record?.actors.find((item) => item.id === binding.actorId);
    const attempt = record?.attempts.find((item) => item.id === binding.attemptId);
    if (
      !record ||
      !actor ||
      !attempt ||
      !["active", "attention"].includes(record.state) ||
      record.generation !== binding.generation ||
      !["starting", "running"].includes(attempt.state) ||
      !["starting", "running"].includes(actor.state)
    )
      return;
    const thread = threads.get(this.db, record.threadId);
    if (!thread) return;
    const id = `approval:${event.runId}:${event.approvalId}`;
    if (!teamNotifications.claim(this.db, { id, executionId: record.id, createdAt: Date.now() })) return;
    const question = event.kind === "user_input";
    this.notify({
      id,
      executionId: record.id,
      actorId: actor.id,
      runId: event.runId,
      approvalId: event.approvalId,
      kind: question ? "question" : "approval",
      ...this.target(record, actor.taskId),
      title: thread.title,
      body: `${this.memberName(record, actor)} ${question ? "has a question" : "needs approval"}. ${clip(event.reason ?? event.toolName ?? "Open the request to respond.")}`,
    });
  }

  private claimAttention(record: TeamExecutionRecord): { id: string; actorId: string | null }[] {
    if (record.state !== "attention") return [];
    const actors = record.actors.filter((actor) => actor.state === "attention");
    const causes = actors.length
      ? actors.map((actor) => ({ actorId: actor.id, id: `attention:${record.id}:${actor.id}:${record.attempts.findLast((attempt) => attempt.actorId === actor.id)?.id ?? "preparation"}` }))
      : [{ actorId: null, id: `attention:${record.id}:execution` }];
    return this.db.transaction(() => causes.filter((cause) => teamNotifications.claim(this.db, { id: cause.id, executionId: record.id, createdAt: Date.now() })));
  }

  private memberName(record: TeamExecutionRecord, actor: TeamActorRecord): string {
    const instance = orchestration.getInstance(this.db, record.threadId);
    const revision = instance ? orchestration.getRevision(this.db, instance.teamRevisionId) : null;
    return revision?.members.find((member) => member.key === actor.memberKey)?.name ?? actor.input.title;
  }
}

function clip(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 180);
}
