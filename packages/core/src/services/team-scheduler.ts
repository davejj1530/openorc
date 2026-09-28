import { schedulingPriority } from "./team-scheduling-priority.js";
import { teamRuntime, threads } from "@openorc/db";
import { harnessShortName, type TeamActorRecord, type TeamAttemptRecord, type TeamExecutionRecord } from "@openorc/protocol";
import { moveActor } from "./team-states.js";
import { errorText, terminal, type SchedulerCore } from "./team-core.js";

/**
 * Decides which ready actors start next: wakes waiting actors whose input or read is due, orders addressed work
 * first, and admits turns within team capacity, workspace barriers and explicit provider ceilings. One execution
 * that cannot be read or advanced is reported and skipped; it never stops the others. Also owns execution deadlines.
 */
export class TeamScheduler {
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  /** Executions skipped after one of their steps failed, with the reason shown to the user; cleared by their next change. */
  private readonly faults = new Map<string, string>();
  private ambientTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduled = false;

  constructor(private readonly core: SchedulerCore) {}

  /** Waiting explanations use scheduler state, not guesses from transcript text. */
  activityReason(execution: TeamExecutionRecord, actor: TeamActorRecord): string | undefined {
    if (actor.modeHold === "plan") return "Waiting for Act";
    if (actor.state === "attention") return actor.error ?? "Needs attention";
    if (actor.state === "queued") {
      const dependencies = actor.dependencies.map((id) => execution.actors.find((item) => item.id === id)).filter((item) => item && item.state !== "completed");
      if (dependencies.length) return `Waiting for ${dependencies.map((item) => item!.input.title).join(", ")}`;
      return this.capacityReason(execution, actor) ?? "Waiting for a turn";
    }
    if (actor.state === "waiting") {
      const children = execution.actors.filter((item) => item.parentId === actor.id && !item.participant && !terminal(item.state));
      if (children.length) return `Waiting for ${children.map((item) => item.input.title).join(", ")}`;
      return actor.ambient ? "Waiting to read the discussion" : "Ready for a message";
    }
    return undefined;
  }

  /** Reports an execution that could not be read or advanced, so it is visible and skipped, and everything else continues. */
  fault(executionId: string, error: unknown): void {
    const message = `This team run could not continue: ${errorText(error)}`;
    if (this.faults.get(executionId) === message) return;
    this.faults.set(executionId, message);
    this.core.hooks.warn?.(`team execution ${executionId}: ${message}`);
    const row = this.core.db.stmt("SELECT thread_id FROM team_executions WHERE id = ?").get(executionId) as { thread_id: string } | undefined;
    if (row) this.core.hooks.changed(row.thread_id);
  }

  /** A successful change shows the execution can advance again. */
  clearFault(executionId: string): void {
    this.faults.delete(executionId);
  }

  /** Why an execution is currently skipped, if one of its steps failed; cleared by its next successful change. */
  faultReason(executionId: string): string | null {
    return this.faults.get(executionId) ?? null;
  }

  schedule(): void {
    if (this.scheduled || this.core.closing) return;
    this.scheduled = true;
    this.core.track(
      Promise.resolve().then(() => {
        this.scheduled = false;
        this.pump();
      }),
    );
  }

  /** Open executions that can be read; one that cannot is reported and skipped rather than stopping the others. */
  openExecutions(): TeamExecutionRecord[] {
    const open: TeamExecutionRecord[] = [];
    for (const id of teamRuntime.openIds(this.core.db)) {
      try {
        const record = teamRuntime.get(this.core.db, id);
        if (record) open.push(record);
      } catch (error) {
        this.fault(id, error);
      }
    }
    return open;
  }

  private pump(): void {
    if (this.core.closing) return;
    const schedulable = this.openExecutions().filter((record) => ["active", "attention"].includes(record.state) && record.deadlineAt > this.core.now() && !this.faults.has(record.id));
    const candidates: { executionId: string; actorId: string; priority: number }[] = [];
    let nextAmbient = Infinity;
    // Each execution advances on its own, so a failing step stops only the execution it belongs to.
    for (const record of schedulable) {
      try {
        nextAmbient = Math.min(nextAmbient, this.wake(record, candidates));
      } catch (error) {
        this.fault(record.id, error);
      }
    }
    this.armAmbient(nextAmbient);
    for (const candidate of candidates.sort((a, b) => a.priority - b.priority)) {
      if (this.faults.has(candidate.executionId)) continue;
      try {
        this.admitCandidate(candidate);
      } catch (error) {
        this.fault(candidate.executionId, error);
      }
    }
  }

  /** Wakes this execution's actors whose input or debounce is due and lists those ready to launch; returns the next ambient due time. */
  private wake(record: TeamExecutionRecord, candidates: { executionId: string; actorId: string; priority: number }[]): number {
    let nextAmbient = Infinity;
    for (const actor of record.actors) {
      if (actor.state === "running") this.core.delivery.flushLiveDirection(record.id, actor.id);
      if (actor.taskId !== null && threads.get(this.core.db, record.threadId)?.mode === "plan") continue;
      const pending = record.messages.filter((message) => message.recipientId === actor.id && message.state === "pending");
      // A follower's debounce has run out: it reads the room now, after anyone who was addressed.
      if (actor.state === "waiting" && actor.ambient && pending.length === 0) {
        if (actor.ambient.dueAt > this.core.now()) nextAmbient = Math.min(nextAmbient, actor.ambient.dueAt);
        else {
          teamRuntime.update(this.core.db, record.id, (state) => {
            const waiting = state.actors.find((item) => item.id === actor.id)!;
            moveActor(waiting, "queued");
            waiting.disposition = null;
          });
          moveActor(actor, "queued");
        }
      }
      if (
        actor.state === "waiting" &&
        pending.length > 0 &&
        (pending.some((message) => message.kind === "direction" || message.kind === "chat") ||
          (actor.disposition?.waitFor ?? []).every((id) => {
            const child = record.actors.find((item) => item.id === id)!;
            return terminal(child.state) || child.state === "attention";
          }))
      ) {
        teamRuntime.update(this.core.db, record.id, (state) => {
          const waiting = state.actors.find((item) => item.id === actor.id)!;
          moveActor(waiting, "queued");
          waiting.disposition = null;
        });
        moveActor(actor, "queued");
      }
      if (actor.state === "queued" && actor.dependencies.every((id) => record.actors.find((item) => item.id === id)?.state === "completed")) {
        // Reconcile existing subtrees before starting more leaf work, including
        // when another execution is competing for the same provider's slots.
        // A member reading the room on its own goes last, so addressed work takes the next free slot; a reader
        // that has since been addressed is addressed work, exactly as its turn will be.
        const priority = schedulingPriority({ actor, pending, actors: record.actors });
        candidates.push({ executionId: record.id, actorId: actor.id, priority });
      }
    }
    return nextAmbient;
  }

  /** Launches one ready actor when its workspace barriers and capacity allow. */
  private admitCandidate(candidate: { executionId: string; actorId: string }): void {
    const record = this.core.status(candidate.executionId);
    const actor = record.actors.find((item) => item.id === candidate.actorId)!;
    if (actor.state !== "queued") return;
    if (actor.taskId !== null && threads.get(this.core.db, record.threadId)?.mode !== "act") return;
    // Exact input transfer requires the manager to yield its workspace first.
    // Also prevent a parent waking while a child's preparation reads/integrates it.
    // Participants share the conversation workspace and never transfer input.
    if (this.core.hooks.workspace && !actor.participant) {
      if (actor.parentId && record.attempts.some((item) => item.actorId === actor.parentId && (this.core.turns.isLaunching(item.id) || Boolean(item.runId && this.core.runs.isLive(item.runId)))))
        return;
      if (record.actors.some((child) => child.parentId === actor.id && record.attempts.some((item) => item.actorId === child.id && this.core.turns.isLaunching(item.id)))) return;
      if (
        actor.parentId &&
        record.actors.some(
          (sibling) => sibling.id !== actor.id && sibling.parentId === actor.parentId && record.attempts.some((item) => item.actorId === sibling.id && this.core.turns.isLaunching(item.id)),
        )
      )
        return;
    }
    if (this.capacityReason(record, actor)) return;
    try {
      this.core.launch(record.id, actor.id);
    } catch (error) {
      const saved = teamRuntime.update(this.core.db, record.id, (state) =>
        this.core.attention(
          state,
          state.actors.find((item) => item.id === actor.id)!,
          errorText(error),
        ),
      ).record;
      this.core.changed(saved);
    }
  }

  /** Team capacity reserves a responsive lead slot; provider ceilings apply only when explicitly configured. */
  capacityReason(record: TeamExecutionRecord, actor: TeamActorRecord): string | null {
    const provider = actor.input.settings.agent;
    const limit = this.core.hooks.providerLimits?.[provider];
    // Only an explicit provider ceiling needs the other executions; a run belongs to one execution, so its latest turn is in its own journal.
    const openAttempts = limit === undefined ? record.attempts : this.openExecutions().flatMap((item) => (item.id === record.id ? record.attempts : item.attempts));
    const latest = new Map(openAttempts.flatMap((attempt) => (attempt.runId ? [[attempt.runId, attempt.id] as const] : [])));
    // Warm idle sessions consume no inference slot; a closing writer still does.
    // Process bindings retain the first turn, so use the journal to identify its current owning attempt.
    const occupies = (attempt: TeamAttemptRecord) => this.core.turns.occupies(attempt, latest);
    const userLead = actor.id === "lead" && record.messages.some((message) => message.recipientId === "lead" && message.senderId === "user" && message.state === "pending");
    // Reserved lead turns retain workspace leases, preparation fences and single-actor ownership.
    if (record.attempts.filter(occupies).length >= record.limits.maxConcurrentAgents + (userLead ? 1 : 0)) return "Waiting for team capacity. Your message is retained.";
    if (limit !== undefined) {
      // Explicit limits (including zero) are hard ceilings for every turn, including the lead.
      const active = openAttempts.filter((attempt) => occupies(attempt) && attempt.settings.agent === provider).length;
      if (active >= limit) return `Waiting for ${harnessShortName(provider)} capacity (${limit} concurrent turns). Your message is retained.`;
    }
    return null;
  }

  /** No timer outlives the coordinator: pending reads and deadlines are recovered from the journal at the next start. */
  shutdown(): void {
    if (this.ambientTimer) clearTimeout(this.ambientTimer);
    this.ambientTimer = null;
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    this.deadlines.clear();
  }

  /** One timer for the earliest pending ambient wake; the pump re-arms it each pass. */
  private armAmbient(dueAt: number): void {
    if (this.ambientTimer) {
      clearTimeout(this.ambientTimer);
      this.ambientTimer = null;
    }
    if (!Number.isFinite(dueAt) || this.core.closing) return;
    this.ambientTimer = setTimeout(
      () => {
        this.ambientTimer = null;
        this.schedule();
      },
      Math.max(1, dueAt - this.core.now()),
    );
    this.ambientTimer.unref?.();
  }

  armDeadline(record: TeamExecutionRecord): void {
    this.clearDeadline(record.id);
    const timer = setTimeout(
      () => {
        this.core.track(this.core.stop(record.id).catch(() => {}));
      },
      Math.max(1, record.deadlineAt - this.core.now()),
    );
    timer.unref();
    this.deadlines.set(record.id, timer);
  }

  clearDeadline(id: string): void {
    const timer = this.deadlines.get(id);
    if (timer) clearTimeout(timer);
    this.deadlines.delete(id);
  }
}
