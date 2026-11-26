import { claudeAccounts, threads, type Db } from "@openorc/db";
import {
  DEFAULT_CLAUDE_ACCOUNT,
  modelWindow,
  percentLeft,
  sessionWindow,
  weeklyWindow,
  type AllowanceWindow,
  type AppSettings,
  type ModelOption,
  type ProviderUsage,
  type Run,
  type Thread,
} from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { PLAN_LIMITS_MAX_AGE_MS } from "./plan-limits.js";
import { projectAccountPolicy, type ProjectAccountPolicy } from "./project-claude-accounts.js";
import type { ProviderUsageService } from "./provider-usage.js";
import type { RunService } from "./runs.js";
import type { RunScope, TurnSettledOutcome } from "./run-types.js";
import type { ThreadService } from "./threads.js";

/** A share older than this may have reset or run out since; the usage view calls it stale too. */
const CURRENT_MS = 5 * 60_000;

/** An account another conversation could go on with, and what its last report says is left. */
export interface AccountReport {
  id: string;
  usage: ProviderUsage;
}

/**
 * The account to go on with. One that shows an open 5-hour window comes first, the one with the most of it left. When
 * none does, a plan that has no 5-hour window at all is a place too, by what is left of its week. Only a current report
 * counts, and an account whose 5-hour or week-long limit is reached, or the limit of the conversation's model alone, is
 * never chosen: the conversation would stop again on its first turn.
 */
export function mostFiveHourLeft(reports: readonly AccountReport[], now: number, model?: string | null): string | null {
  let best: { id: string; left: number } | null = null;
  let weekly: { id: string; left: number } | null = null;
  for (const { id, usage } of reports) {
    const room = roomLeft(usage, now, model);
    if (room?.fiveHour) {
      if (!best || room.left > best.left) best = { id, left: room.left };
    } else if (room && (!weekly || room.left > weekly.left)) weekly = { id, left: room.left };
  }
  return best?.id ?? weekly?.id ?? null;
}

const open = (window: AllowanceWindow, now: number) => !window.exhausted && (percentLeft(window) ?? 0) > 0 && now - window.observedAt < CURRENT_MS;

/** What is left of the account's 5-hour window, or of its week on a plan without one; null when it is no place to go. */
function roomLeft(usage: ProviderUsage, now: number, model?: string | null): { fiveHour: boolean; left: number } | null {
  if (usage.status !== "available") return null;
  const session = sessionWindow(usage.windows);
  const week = weeklyWindow(usage.windows);
  const own = model ? modelWindow(usage.windows, model) : null;
  if ((week && !open(week, now)) || (own && !open(own, now))) return null;
  if (session) return open(session, now) ? { fiveHour: true, left: percentLeft(session)! } : null;
  return week ? { fiveHour: false, left: percentLeft(week)! } : null;
}

/** When the account's limits were last read: its 5-hour window's reading, or its week's on a plan without one. */
function readAt(usage: ProviderUsage): number {
  return (sessionWindow(usage.windows) ?? weeklyWindow(usage.windows))?.observedAt ?? 0;
}

const reached = (window: AllowanceWindow) => window.exhausted || (percentLeft(window) ?? 0) <= 0;

/** Whether the limit of the model alone is used up on the account, the account's own limits aside. */
function modelLimitReached(usage: ProviderUsage, model: string): boolean {
  const own = modelWindow(usage.windows, model);
  return own !== null && reached(own);
}

/**
 * Fable has a week-long limit of its own, which can run out on every account while their own limits still have room.
 * A conversation on Fable then goes on with the newest Opus, at the same effort.
 */
const RUNS_OUT = /fable/i;
const GOES_ON_WITH = /opus/i;

const fallsBack = (model: string | null): model is string => model !== null && RUNS_OUT.test(model);

function fallbackModel(models: readonly ModelOption[], effort: string | null): ModelOption | null {
  return models.find((model) => model.agent === "claude" && GOES_ON_WITH.test(model.id) && !model.unavailable && !model.legacy && (!effort || model.efforts.includes(effort))) ?? null;
}

/** How a stopped conversation with no account to go on with keeps looking: soon, then at a steady pace, for a while. */
export interface LookAgain {
  firstMs: number;
  everyMs: number;
  forMs: number;
}

/** A 5-hour window always resets within five hours, so six covers every account's. */
const LOOK_AGAIN: LookAgain = { firstMs: 30_000, everyMs: 5 * 60_000, forMs: 6 * 60 * 60_000 };

interface Dependencies {
  db: Db;
  settings: { get(): Pick<AppSettings, "claudeAccountAutoSwitch" | "claudeAccountsSeparate"> };
  usage: Pick<ProviderUsageService, "recent">;
  runs: Pick<RunService, "threadSession" | "models">;
  threads: Pick<ThreadService, "continueThread">;
  log: Pick<Logger, "warn">;
  lookAgain?: LookAgain;
}

/** Why an account is no place to go, in a few words for the log. */
function whyNot(report: AccountReport | null, now: number, model: string | null): string {
  if (!report) return "its usage could not be read";
  if (report.usage.status !== "available") return "its usage is not available";
  const session = sessionWindow(report.usage.windows);
  const week = weeklyWindow(report.usage.windows);
  if (!session && !week) return "it reports no limits to judge by";
  if (now - readAt(report.usage) >= CURRENT_MS) return "its last usage reading is too old";
  if (session && reached(session)) return "its 5-hour limit is reached";
  if (week && reached(week)) return "its week's limit is reached";
  if (model && modelLimitReached(report.usage, model)) return `its limit for ${model} is reached`;
  return "nothing left";
}

/**
 * With the setting on, a conversation its Claude account's usage limit stopped goes on with the account that has the
 * most left. A project with its own accounts decides with its own setting, among its own accounts. When no account has
 * anything left at that moment, it keeps looking until one does, the limit of its own account included once that has
 * reset, or until the person writes to it, moves it, or turns the setting off.
 */
export class ClaudeAccountSwitch {
  private readonly moving = new Set<string>();
  /** The conversations still looking for an account, by thread. */
  private readonly looking = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: Dependencies) {}

  /** The thread's project's accounts and whether it switches, as they stand now. */
  private policy(thread: Pick<Thread, "projectId">): ProjectAccountPolicy {
    return projectAccountPolicy(this.deps.db, thread.projectId, this.deps.settings.get());
  }

  settled(run: Run, scope: RunScope, outcome: TurnSettledOutcome): void {
    const thread = scope.thread;
    if (!thread || outcome.status !== "error" || run.agent !== "claude" || run.orclingId || !this.policy(thread).autoSwitch) return;
    if (!this.stoppedAtLimit(thread.id)) return;
    this.attempt(thread.id, run.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT, Date.now(), true);
  }

  /** Stops every pending look, as the app closes. */
  close(): void {
    for (const timer of this.looking.values()) clearTimeout(timer);
    this.looking.clear();
  }

  private attempt(threadId: string, from: string, since: number, first: boolean): void {
    if (this.moving.has(threadId)) return;
    this.moving.add(threadId);
    void this.move(threadId, from, since, first)
      .catch((error: unknown) => {
        this.deps.log.warn(`thread ${threadId}: could not move to another Claude account: ${error instanceof Error ? error.message : String(error)}`);
        // A read that failed is no reason to leave the conversation stopped for good.
        return "none" as const;
      })
      .then((outcome) => {
        if (outcome === "none") this.lookLater(threadId, from, since, first);
        else this.forget(threadId);
      })
      .finally(() => this.moving.delete(threadId));
  }

  private forget(threadId: string): void {
    const timer = this.looking.get(threadId);
    if (timer) clearTimeout(timer);
    this.looking.delete(threadId);
  }

  private lookLater(threadId: string, from: string, since: number, first: boolean): void {
    const pace = this.deps.lookAgain ?? LOOK_AGAIN;
    this.forget(threadId);
    if (Date.now() - since >= pace.forMs) {
      this.deps.log.warn(`thread ${threadId}: no Claude account became free; it stays stopped at its usage limit`);
      return;
    }
    const timer = setTimeout(
      () => {
        this.looking.delete(threadId);
        // A timer cannot throw into the host.
        try {
          const thread = threads.get(this.deps.db, threadId);
          if (!thread || thread.agent !== "claude" || (thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT) !== from || !this.policy(thread).autoSwitch || !this.stoppedAtLimit(threadId)) return;
          this.attempt(threadId, from, since, false);
        } catch (error) {
          this.deps.log.warn(`thread ${threadId}: could not look for a Claude account again: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      first ? pace.firstMs : pace.everyMs,
    );
    timer.unref();
    this.looking.set(threadId, timer);
  }

  private stoppedAtLimit(threadId: string): boolean {
    const { status, recovery } = this.deps.runs.threadSession(threadId);
    return status === "error" && recovery?.kind === "usage" && recovery.provider === "claude";
  }

  /**
   * "moved" when the conversation goes on, "none" when no account has anything left yet, and "left" when it is no
   * longer this switch's to move: the person moved it, wrote to it, or changed what its project allows.
   */
  private async move(threadId: string, from: string, since: number, first: boolean): Promise<"moved" | "none" | "left"> {
    const { db } = this.deps;
    const current = threads.get(db, threadId);
    if (!current) return "left";
    // On the first look its own account is no place for its model, and is read only for the model Fable goes on with.
    const places = this.policy(current).allowed.filter((id) => !first || id !== from || fallsBack(current.model));
    if (!places.length) return "left";
    const read = await this.read(places);
    const now = Date.now();
    const thread = this.stillStopped(threadId, from);
    if (!thread) return "left";
    const allowed = this.policy(thread).allowed;
    // A reading of its own account from before the stop still says a little is left.
    const reports = read.filter((report) => report !== null).filter((report) => allowed.includes(report.id) && (report.id !== from || readAt(report.usage) > since));
    // Its own account is a place for its model again once its limit has reset, never on the first look: a reading just after the stop can still say a little is left.
    const to = mostFiveHourLeft(
      reports.filter((report) => !first || report.id !== from),
      now,
      thread.model,
    );
    if (to) {
      const prompt =
        to === from
          ? `The usage limit of the Claude account ${name(db, from)} has reset. Continue where you left off.`
          : `Moved to the Claude account ${name(db, to)} after ${name(db, from)} reached its usage limit. Continue where you left off.`;
      await this.deps.threads.continueThread(threadId, continuation(thread, to, prompt));
      return "moved";
    }
    const instead = await this.otherModel(thread, from, first, reports, now);
    if (!instead) {
      if (first) this.sayWhyNone(thread, from, places, read, now);
      return "none";
    }
    const prompt =
      instead.to === from
        ? `No Claude account has Fable usage left, so this conversation goes on with ${instead.model.label} at the same effort. Continue where you left off.`
        : `No Claude account has Fable usage left, so this conversation goes on with ${instead.model.label} on the Claude account ${name(db, instead.to)}, at the same effort. Continue where you left off.`;
    await this.deps.threads.continueThread(threadId, { ...continuation(thread, instead.to, prompt), model: instead.model.id });
    return "moved";
  }

  /** Each account's last report, or null where it could not be read. */
  private read(places: readonly string[]): Promise<(AccountReport | null)[]> {
    return Promise.all(
      places.map((id) =>
        this.deps.usage.recent("claude", id, PLAN_LIMITS_MAX_AGE_MS).then(
          (report): AccountReport => ({ id, usage: report }),
          () => null,
        ),
      ),
    );
  }

  /** The thread while it is still this switch's to move: on the same account, stopped at its limit, its project switching. */
  private stillStopped(threadId: string, from: string): Thread | null {
    const thread = threads.get(this.deps.db, threadId);
    // While usage was read, the person may have moved the conversation, or written to it, or changed what its project allows.
    if (!thread || thread.agent !== "claude" || (thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT) !== from || !this.stoppedAtLimit(threadId)) return null;
    return this.policy(thread).autoSwitch ? thread : null;
  }

  /** For a conversation on Fable that no account has Fable left for: the model it goes on with, and where. */
  private async otherModel(thread: Thread, from: string, first: boolean, reports: readonly AccountReport[], now: number): Promise<{ model: ModelOption; to: string } | null> {
    const stopped = thread.model;
    if (!fallsBack(stopped)) return null;
    const model = fallbackModel(await this.deps.runs.models("claude", undefined, undefined, from), thread.effort);
    if (!model) return null;
    // When the model's own limit is what stopped it, its own account has room for the other model at once.
    const to = mostFiveHourLeft(
      reports.filter((report) => !first || report.id !== from || modelLimitReached(report.usage, stopped)),
      now,
      model.id,
    );
    return to ? { model, to } : null;
  }

  private sayWhyNone(thread: Thread, from: string, places: readonly string[], read: readonly (AccountReport | null)[], now: number): void {
    const { db } = this.deps;
    const why = places.flatMap((id, index) => (id === from ? [] : [`${name(db, id)}: ${whyNot(read[index] ?? null, now, thread.model)}`])).join("; ");
    this.deps.log.warn(`thread ${thread.id}: stopped at ${name(db, from)}'s usage limit with no Claude account to go on with (${why}); looking again until one is free`);
  }
}

function name(db: Db, id: string): string {
  return claudeAccounts.get(db, id).name;
}

/** The conversation's next turn as it stood, on the given account, opened by OpenOrc's notice. */
export function continuation(thread: Thread, claudeAccountId: string, prompt: string): Parameters<ThreadService["continueThread"]>[1] {
  return {
    agent: thread.agent,
    model: thread.model ?? undefined,
    effort: thread.effort ?? undefined,
    fastMode: thread.fastMode,
    mode: thread.mode,
    permissionMode: thread.permissionMode,
    prompt,
    attachments: undefined,
    promptRole: "system",
    claudeAccountId,
  };
}
