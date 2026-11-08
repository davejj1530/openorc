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
 * The account with the most of its 5-hour window left. Only a current report counts, and an account whose 5-hour or
 * week-long limit is reached is never chosen: the conversation would stop again on its first turn.
 */
export function mostFiveHourLeft(reports: readonly AccountReport[], now: number): string | null {
  const open = (window: AllowanceWindow | null) => window !== null && !window.exhausted && (percentLeft(window) ?? 0) > 0 && now - window.observedAt < CURRENT_MS;
  let best: { id: string; left: number } | null = null;
  for (const { id, usage } of reports) {
    if (usage.status !== "available") continue;
    const session = sessionWindow(usage.windows);
    const week = weeklyWindow(usage.windows);
    if (!open(session) || (week && !open(week))) continue;
    const left = percentLeft(session!)!;
    if (!best || left > best.left) best = { id, left };
  }
  return best?.id ?? null;
}

interface Dependencies {
  db: Db;
  settings: { get(): Pick<AppSettings, "claudeAccountAutoSwitch"> };
  usage: Pick<ProviderUsageService, "recent">;
  runs: Pick<RunService, "threadSession">;
  threads: Pick<ThreadService, "continueThread">;
  log: Pick<Logger, "warn">;
}

/**
 * With the setting on, a conversation its Claude account's usage limit stopped goes on with the account that has the
 * most left. A project with its own accounts decides with its own setting, among its own accounts.
 */
export class ClaudeAccountSwitch {
  private readonly moving = new Set<string>();

  constructor(private readonly deps: Dependencies) {}

  /** The thread's project's accounts and whether it switches, as they stand now. */
  private policy(thread: Pick<Thread, "projectId">): ProjectAccountPolicy {
    return projectAccountPolicy(this.deps.db, thread.projectId, this.deps.settings.get());
  }

  settled(run: Run, scope: RunScope, outcome: TurnSettledOutcome): void {
    const thread = scope.thread;
    if (!thread || outcome.status !== "error" || run.agent !== "claude" || run.orclingId || !this.policy(thread).autoSwitch) return;
    if (!this.stoppedAtLimit(thread.id) || this.moving.has(thread.id)) return;
    this.moving.add(thread.id);
    void this.move(thread.id, run.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT)
      .catch((error: unknown) => this.deps.log.warn(`thread ${thread.id}: could not move to another Claude account: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.moving.delete(thread.id));
  }

  private stoppedAtLimit(threadId: string): boolean {
    const { status, recovery } = this.deps.runs.threadSession(threadId);
    return status === "error" && recovery?.kind === "usage" && recovery.provider === "claude";
  }

  private async move(threadId: string, from: string): Promise<void> {
    const { db, usage } = this.deps;
    const current = threads.get(db, threadId);
    const others = current ? this.policy(current).allowed.filter((id) => id !== from) : [];
    if (!others.length) return;
    const reports = await Promise.all(
      others.map((id) =>
        usage.recent("claude", id, PLAN_LIMITS_MAX_AGE_MS).then(
          (report): AccountReport => ({ id, usage: report }),
          () => null,
        ),
      ),
    );
    const to = mostFiveHourLeft(
      reports.filter((report) => report !== null),
      Date.now(),
    );
    const thread = threads.get(db, threadId);
    // While usage was read, the person may have moved the conversation, or written to it, or changed what its project allows.
    if (!to || !thread || thread.agent !== "claude" || (thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT) !== from || !this.stoppedAtLimit(threadId)) return;
    const policy = this.policy(thread);
    if (!policy.autoSwitch || !policy.allowed.includes(to)) return;
    await this.deps.threads.continueThread(
      threadId,
      continuation(thread, to, `Moved to the Claude account ${name(db, to)} after ${name(db, from)} reached its usage limit. Continue where you left off.`),
    );
  }
}

function name(db: Db, id: string): string {
  return claudeAccounts.get(db, id).name;
}

/** The conversation's next turn as it stood, on another account, opened by OpenOrc's notice. */
function continuation(thread: Thread, claudeAccountId: string, prompt: string): Parameters<ThreadService["continueThread"]>[1] {
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
