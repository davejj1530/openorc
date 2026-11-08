import { audit, projects, retiredTeams, scheduleFirings, schedules, threads as threadRows, type Db, type SchedulePatch } from "@openorc/db";
import { normalizeModelSettings, ScheduleLaunchSnapshot, type RpcParams, type Schedule, type ScheduleFiringRecord, type ScheduleRunResult, type Thread } from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import type { Logger } from "../transport.js";
import { startingAccount } from "./project-claude-accounts.js";
import type { Notification } from "./runs.js";
import type { ThreadService } from "./threads.js";

export type ScheduleInput = RpcParams<"schedules.create">;
export interface ScheduleHooks {
  maintenance?: () => boolean;
}
class FiringCancelled extends Error {}
class FiringSkipped extends Error {}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Each firing has a durable receipt, committed atomically with its new thread. */
export class ScheduleService {
  private timer: NodeJS.Timeout | null = null;
  private closing = false;
  private readonly inFlight = new Map<string, Promise<ScheduleRunResult>>();
  private readonly legacyFlights = new Map<string, Promise<Thread>>();
  /** Each schedule's account fallback the log has told of, so it says so once rather than at every firing. */
  private readonly accountFallbacks = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly threads: Pick<ThreadService, "start">,
    private readonly invalidate: (keys: string[]) => void,
    private readonly notify: (n: Omit<Notification, "type">) => void,
    private readonly log: Logger,
    private readonly hooks?: ScheduleHooks,
  ) {}

  start(): void {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => void this.tick().catch((error) => this.log.warn(`Schedule tick failed: ${errorText(error)}`)), 60_000);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  get hasPendingWork(): boolean {
    return this.inFlight.size > 0 || this.legacyFlights.size > 0;
  }

  stopAccepting(): void {
    this.closing = true;
    this.stop();
  }

  async shutdown(): Promise<void> {
    this.stopAccepting();
    await Promise.allSettled([...this.inFlight.values()]);
  }

  list(projectId?: string): Schedule[] {
    return schedules.list(this.db, projectId);
  }
  private normalize(input: ScheduleInput): ScheduleLaunchSnapshot {
    if (!projects.get(this.db, input.projectId)) throw new Error(`project ${input.projectId} not found`);
    let target = input.executionTarget ?? null;
    let agent = input.agent;
    let model = input.model ?? null;
    let effort = input.effort ?? null;
    let workspaceMode = input.workspaceMode;
    if (target?.kind === "model") {
      target = { ...target, settings: normalizeModelSettings(target.settings) };
      ({ agent, model, effort } = target.settings);
    } else if (target?.kind === "orcling") {
      throw new Error("Choose a model for this schedule.");
    }
    if (!agent) throw new Error("Choose a model for this schedule.");
    return ScheduleLaunchSnapshot.parse({ ...input, executionTarget: target, ...normalizeModelSettings({ agent, model, effort }), workspaceMode });
  }
  /**
   * A Claude account a person chose for a schedule must be one its project uses; with none chosen, the project's default.
   * Another agent's schedule only carries one along.
   */
  private chosenAccount(input: Pick<ScheduleInput, "projectId" | "claudeAccountId">, agent: string | undefined): string {
    return startingAccount(this.db, input.projectId, input.claudeAccountId, agent === "claude" ? "chosen" : "unused");
  }
  create(input: ScheduleInput): Schedule {
    const normalized = this.normalize(input);
    const schedule = schedules.insert(this.db, { ...normalized, claudeAccountId: this.chosenAccount(input, normalized.agent) });
    audit.record(this.db, { actor: "user", action: "schedule.create", resourceType: "schedule", resourceId: schedule.id, metadata: { everyMinutes: schedule.everyMinutes } });
    this.invalidate(["schedules"]);
    return schedule;
  }
  update(id: string, patch: SchedulePatch): Schedule {
    const current = schedules.get(this.db, id);
    if (!current) throw new Error(`schedule ${id} not found`);
    if (current.retiredTeam) throw new Error("Schedule not found.");
    const normalized = this.normalize({ ...current, ...patch });
    const account = patch.claudeAccountId ? this.chosenAccount({ projectId: current.projectId, claudeAccountId: patch.claudeAccountId }, normalized.agent) : undefined;
    // A changed interval or re-enabled timer starts a new cadence, never a backlog.
    const nextRunAt = (patch.everyMinutes && patch.everyMinutes !== current.everyMinutes) || (patch.enabled && !current.enabled) ? Date.now() + normalized.everyMinutes * 60_000 : patch.nextRunAt;
    const { projectId: _projectId, ...configuration } = normalized;
    const schedule = schedules.update(this.db, id, { ...patch, ...configuration, ...(account ? { claudeAccountId: account } : {}), ...(nextRunAt !== undefined ? { nextRunAt } : {}) });
    this.invalidate(["schedules"]);
    return schedule;
  }
  delete(id: string): void {
    schedules.delete(this.db, id);
    this.invalidate(["schedules"]);
  }

  async tick(): Promise<void> {
    if (this.closing || this.hooks?.maintenance?.()) return;
    // A crash before admission resumes the same receipt and immutable snapshot.
    for (const pending of scheduleFirings.pending(this.db)) {
      if (this.closing || this.hooks?.maintenance?.()) return;
      await this.process(pending);
    }
    for (const listed of schedules.due(this.db, Date.now())) {
      if (this.closing || this.hooks?.maintenance?.()) return;
      // An earlier schedule can await readiness while this one is edited or
      // manually fired. Bookkeeping does not change its configuration version.
      const schedule = schedules.get(this.db, listed.id);
      if (!schedule || schedule.retiredTeam || !schedule.enabled || schedule.nextRunAt > Date.now()) continue;
      const key = `timer:${schedule.version}:${schedule.nextRunAt}`;
      const firing =
        scheduleFirings.findRequest(this.db, schedule.id, key) ??
        scheduleFirings.reserve(this.db, {
          scheduleId: schedule.id,
          requestKey: key,
          scheduleVersion: schedule.version,
          trigger: "timer",
          scheduledFor: schedule.nextRunAt,
          snapshot: ScheduleLaunchSnapshot.parse(schedule),
        });
      await this.process(firing);
    }
  }
  trigger(id: string, requestKey: string): Promise<ScheduleRunResult> {
    if (this.hooks?.maintenance?.()) throw new Error("An agent update is running. Try again when it finishes.");
    if (!requestKey.trim() || requestKey.length > 300) throw new Error("A schedule launch needs a request key of at most 300 characters.");
    if (schedules.get(this.db, id)?.retiredTeam) throw new Error("Schedule not found.");
    const previous = scheduleFirings.findRequest(this.db, id, requestKey);
    if (previous) return this.process(previous);
    if (this.closing) throw new Error("Schedules are shutting down. Try again after the app reopens.");
    const schedule = schedules.get(this.db, id);
    if (!schedule) throw new Error(`schedule ${id} not found`);
    if (schedule.retiredTeam) throw new Error("This item is no longer available.");
    return this.process(
      scheduleFirings.reserve(this.db, { scheduleId: id, requestKey, scheduleVersion: schedule.version, trigger: "manual", scheduledFor: null, snapshot: ScheduleLaunchSnapshot.parse(schedule) }),
    );
  }
  /** Legacy callers still receive Thread and concurrent clicks share one firing. */
  fire(schedule: Schedule): Promise<Thread> {
    const existing = this.legacyFlights.get(schedule.id);
    if (existing) return existing;
    const pending = this.trigger(schedule.id, `legacy:${randomUUID()}`)
      .then((result) => {
        if (result.status !== "started") throw new Error(result.reason);
        return result.thread;
      })
      .finally(() => this.legacyFlights.delete(schedule.id));
    this.legacyFlights.set(schedule.id, pending);
    return pending;
  }
  private process(firing: ScheduleFiringRecord): Promise<ScheduleRunResult> {
    const existing = this.inFlight.get(firing.id);
    if (existing) return existing;
    // A tick may have collected this row before another request admitted it.
    const current = scheduleFirings.get(this.db, firing.id);
    if (!current) return Promise.resolve({ status: "cancelled", firingId: firing.id, reason: "The schedule was deleted before it started." });
    firing = current;
    if (firing.state !== "pending") return Promise.resolve(this.result(firing));
    const pending = this.execute(firing).finally(() => this.inFlight.delete(firing.id));
    this.inFlight.set(firing.id, pending);
    return pending;
  }
  private result(firing: ScheduleFiringRecord): ScheduleRunResult {
    if (firing.state === "started") {
      const thread = firing.threadId && !retiredTeams.isHidden(this.db, firing.threadId) ? threadRows.get(this.db, firing.threadId) : null;
      if (thread) return { status: "started", firingId: firing.id, thread };
      return { status: "failed", firingId: firing.id, reason: "This firing was already admitted, but its conversation was deleted. It will not launch again." };
    }
    if (firing.state === "pending") throw new Error("The schedule firing has not settled.");
    return { status: firing.state, firingId: firing.id, reason: firing.reason ?? `The schedule firing was ${firing.state}.`, ...(firing.threadId ? { threadId: firing.threadId } : {}) };
  }
  private assertCanAdmit(firing: ScheduleFiringRecord): void {
    if (this.closing) throw new FiringCancelled("The app is shutting down. This firing was not started.");
    const schedule = schedules.get(this.db, firing.scheduleId);
    if (!schedule) throw new FiringCancelled("The schedule was deleted before it started.");
    if (schedule.retiredTeam) throw new FiringCancelled("This item is no longer available.");
    if (schedule.version !== firing.scheduleVersion) throw new FiringCancelled("The schedule changed before it started.");
    if (firing.trigger === "timer" && !schedule.enabled) throw new FiringCancelled("The schedule was disabled before it started.");
    let reachedCurrent = false;
    for (const prior of scheduleFirings.list(this.db, schedule.id)) {
      if (prior.id === firing.id) {
        reachedCurrent = true;
        continue;
      }
      // After restart there can be multiple retained reservations. The oldest
      // keeps admission priority; a newer reservation must not displace it.
      if (prior.state === "pending" && !reachedCurrent) throw new FiringSkipped("Another firing of this schedule is being prepared.");
    }
  }
  private bookkeeping(firing: ScheduleFiringRecord, thread?: Thread): void {
    const current = schedules.get(this.db, firing.scheduleId);
    if (!current || current.version !== firing.scheduleVersion) return;
    if (thread) schedules.update(this.db, current.id, { lastRunAt: Date.now(), nextRunAt: Date.now() + firing.snapshot.everyMinutes * 60_000, lastThreadId: thread.id });
    else if (firing.trigger === "timer") schedules.update(this.db, current.id, { nextRunAt: Date.now() + firing.snapshot.everyMinutes * 60_000 });
  }
  /**
   * The account a firing starts on: the one the schedule was saved with, or its project's default once the project no
   * longer uses that one, so the schedule goes on firing. The log says so the first time, and again only if the accounts
   * involved change.
   */
  private firingAccount({ scheduleId, snapshot }: ScheduleFiringRecord): string {
    const saved = snapshot.claudeAccountId ?? "claude-cli";
    const account = startingAccount(this.db, snapshot.projectId, saved, snapshot.agent === "claude" ? "inherited" : "unused");
    const fallback = `${scheduleId}:${saved}:${account}`;
    if (account !== saved && snapshot.agent === "claude" && !this.accountFallbacks.has(fallback)) {
      this.accountFallbacks.add(fallback);
      this.log.warn(`Schedule "${snapshot.title}" runs on its project's default Claude account; its project no longer uses the one it was saved with.`);
    }
    return account;
  }

  private async execute(firing: ScheduleFiringRecord): Promise<ScheduleRunResult> {
    let admitted = false;
    let startupFailed = false;
    const accept = (thread: Thread, executionId?: string) => {
      const current = scheduleFirings.get(this.db, firing.id);
      if (current?.state === "started") return;
      this.assertCanAdmit(firing);
      scheduleFirings.settle(this.db, firing.id, { state: "started", threadId: thread.id, ...(executionId ? { executionId } : {}) });
      this.bookkeeping(firing, thread);
      audit.record(this.db, {
        actor: "openorc",
        action: "schedule.fire",
        resourceType: "schedule",
        resourceId: firing.scheduleId,
        metadata: { threadId: thread.id, firingId: firing.id, ...(executionId ? { executionId } : {}) },
      });
      admitted = true;
    };
    try {
      this.assertCanAdmit(firing);
      const snapshot = firing.snapshot;
      const when = new Date(firing.scheduledFor ?? firing.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const common = {
        projectId: snapshot.projectId,
        claudeAccountId: this.firingAccount(firing),
        claudeAccountFrom: "inherited" as const,
        mode: snapshot.mode,
        permissionMode: snapshot.permissionMode,
        workspaceMode: snapshot.workspaceMode,
        prompt: snapshot.prompt,
        title: `${snapshot.title} · ${when}`,
      };
      {
        const settings = snapshot.executionTarget?.kind === "model" ? snapshot.executionTarget.settings : null;
        const { thread } = await this.threads.start(
          { ...common, agent: snapshot.agent, model: snapshot.model ?? undefined, effort: snapshot.effort ?? undefined, ...(settings ? { fastMode: settings.fastMode } : {}), attachments: undefined },
          {
            assertCanAdmit: () => this.assertCanAdmit(firing),
            onAdmitted: (thread) => accept(thread),
          },
        );
        // Supports legacy injected start implementations; real starts admit before setup.
        if (scheduleFirings.get(this.db, firing.id)?.state === "pending") this.db.transaction(() => accept(thread));
      }
    } catch (error) {
      const current = scheduleFirings.get(this.db, firing.id);
      if (current?.state === "started") {
        // Admission is final even if workspace setup or provider startup then failed.
        startupFailed = true;
        this.log.warn(`Schedule "${firing.snapshot.title}" was admitted but startup failed: ${errorText(error)}`);
      } else {
        const state = failedFiringState(error);
        const reason = errorText(error);
        if (current)
          this.db.transaction(() => {
            scheduleFirings.settle(this.db, firing.id, { state, reason });
            this.bookkeeping(firing);
          });
        this.invalidate(["schedules"]);
        if (state === "failed") this.log.warn(`Schedule "${firing.snapshot.title}" failed: ${reason}`);
        return { status: state, firingId: firing.id, reason };
      }
    }
    const result = this.result(scheduleFirings.get(this.db, firing.id)!);
    if (admitted && result.status === "started")
      this.notify({
        kind: "schedule",
        threadId: result.thread.id,
        taskId: null,
        title: firing.snapshot.title,
        body: startupFailed ? "Task created, but startup needs attention." : "Started on schedule.",
      });
    this.invalidate(["schedules", "threads"]);
    return result;
  }
}

function failedFiringState(error: unknown): "cancelled" | "skipped" | "failed" {
  if (error instanceof FiringCancelled) return "cancelled";
  if (error instanceof FiringSkipped) return "skipped";
  return "failed";
}
