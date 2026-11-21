import { claudeAccounts, threads, type Db } from "@openorc/db";
import { DEFAULT_CLAUDE_ACCOUNT, percentLeft, sessionWindow, weeklyWindow, type AllowanceWindow, type AppSettings, type ProviderUsage, type Run, type Thread } from "@openorc/protocol";
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
 * counts, and an account whose 5-hour or week-long limit is reached is never chosen: the conversation would stop again
 * on its first turn.
 */
export function mostFiveHourLeft(reports: readonly AccountReport[], now: number): string | null {
  const open = (window: AllowanceWindow | null) => window !== null && !window.exhausted && (percentLeft(window) ?? 0) > 0 && now - window.observedAt < CURRENT_MS;
  let best: { id: string; left: number } | null = null;
  let weekly: { id: string; left: number } | null = null;
  for (const { id, usage } of reports) {
    if (usage.status !== "available") continue;
    const session = sessionWindow(usage.windows);
    const week = weeklyWindow(usage.windows);
    if (week && !open(week)) continue;
    if (session) {
      if (!open(session)) continue;
      const left = percentLeft(session)!;
      if (!best || left > best.left) best = { id, left };
    } else if (week) {
      const left = percentLeft(week)!;
      if (!weekly || left > weekly.left) weekly = { id, left };
    }
  }
  return best?.id ?? weekly?.id ?? null;
}

/** When the account's limits were last read: its 5-hour window's reading, or its week's on a plan without one. */
function readAt(usage: ProviderUsage): number {
  return (sessionWindow(usage.windows) ?? weeklyWindow(usage.windows))?.observedAt ?? 0;
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
  runs: Pick<RunService, "threadSession">;
  threads: Pick<ThreadService, "continueThread">;
  log: Pick<Logger, "warn">;
  lookAgain?: LookAgain;
}

/** Why an account is no place to go, in a few words for the log. */
function whyNot(report: AccountReport | null, now: number): string {
  if (!report) return "its usage could not be read";
  if (report.usage.status !== "available") return "its usage is not available";
  const session = sessionWindow(report.usage.windows);
  const week = weeklyWindow(report.usage.windows);
  if (!session && !week) return "it reports no limits to judge by";
  if (now - readAt(report.usage) >= CURRENT_MS) return "its last usage reading is too old";
  if (session && (session.exhausted || (percentLeft(session) ?? 0) <= 0)) return "its 5-hour limit is reached";
  if (week && (week.exhausted || (percentLeft(week) ?? 0) <= 0)) return "its week's limit is reached";
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
    const { db, usage } = this.deps;
    const current = threads.get(db, threadId);
    if (!current) return "left";
    // Its own account is a place to go again once its limit has reset, never on the first look: the reading from just before the stop still says a little is left.
    const places = this.policy(current).allowed.filter((id) => !first || id !== from);
    if (!places.length) return "left";
    const read = await Promise.all(
      places.map((id) =>
        usage.recent("claude", id, PLAN_LIMITS_MAX_AGE_MS).then(
          (report): AccountReport => ({ id, usage: report }),
          () => null,
        ),
      ),
    );
    const now = Date.now();
    const reports = read.filter((report) => report !== null).filter((report) => report.id !== from || readAt(report.usage) > since);
    const to = mostFiveHourLeft(reports, now);
    const thread = threads.get(db, threadId);
    // While usage was read, the person may have moved the conversation, or written to it, or changed what its project allows.
    if (!thread || thread.agent !== "claude" || (thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT) !== from || !this.stoppedAtLimit(threadId)) return "left";
    const policy = this.policy(thread);
    if (!policy.autoSwitch) return "left";
    if (!to || !policy.allowed.includes(to)) {
      if (first) {
        const why = places.map((id, index) => `${name(db, id)}: ${whyNot(read[index] ?? null, now)}`).join("; ");
        this.deps.log.warn(`thread ${threadId}: stopped at ${name(db, from)}'s usage limit with no Claude account to go on with (${why}); looking again until one is free`);
      }
      return "none";
    }
    const prompt =
      to === from
        ? `The usage limit of the Claude account ${name(db, from)} has reset. Continue where you left off.`
        : `Moved to the Claude account ${name(db, to)} after ${name(db, from)} reached its usage limit. Continue where you left off.`;
    await this.deps.threads.continueThread(threadId, continuation(thread, to, prompt));
    return "moved";
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
