import { claudeAccounts, threads, type Db } from "@openorc/db";
import { DEFAULT_CLAUDE_ACCOUNT, type Run } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { continuation } from "./claude-account-switch.js";
import type { ClaudeAccountService } from "./claude-accounts.js";
import type { RunScope, TurnSettledOutcome } from "./run-types.js";
import type { RunService } from "./runs.js";
import type { ThreadService } from "./threads.js";

interface Dependencies {
  db: Db;
  accounts: Pick<ClaudeAccountService, "signedIn">;
  runs: Pick<RunService, "threadSession">;
  threads: Pick<ThreadService, "continueThread">;
  log: Pick<Logger, "warn">;
}

/**
 * Claude Code reads its login as it starts, and a macOS keychain item that another Claude process is rewriting in place,
 * as one does when it refreshes a connector's token, can read as missing for that moment. The new process then says it
 * is not logged in. A conversation stopped that way asks the account's CLI again: signed in, it goes on once on the same
 * account; signed out, it keeps its way to sign in.
 */
export class ClaudeSignInRetry {
  private readonly checking = new Set<string>();
  /** Runs this started. One that stops signed out too keeps its sign-in. */
  private readonly retries = new Set<string>();

  constructor(private readonly deps: Dependencies) {}

  settled(run: Run, scope: RunScope, outcome: TurnSettledOutcome): void {
    const thread = scope.thread;
    if (this.retries.delete(run.id) || !thread || outcome.status !== "error" || run.agent !== "claude" || run.orclingId) return;
    if (!this.signedOut(thread.id) || this.checking.has(thread.id)) return;
    this.checking.add(thread.id);
    void this.retry(thread.id, run.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT)
      .catch((error: unknown) => this.deps.log.warn(`thread ${thread.id}: could not go on after Claude said it was signed out: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.checking.delete(thread.id));
  }

  private signedOut(threadId: string): boolean {
    const { status, recovery } = this.deps.runs.threadSession(threadId);
    return status === "error" && recovery?.kind === "sign_in" && recovery.provider === "claude";
  }

  private async retry(threadId: string, account: string): Promise<void> {
    const { db } = this.deps;
    if (!(await this.deps.accounts.signedIn(account))) return;
    const thread = threads.get(db, threadId);
    // While the CLI was asked, the person may have moved the conversation or written to it.
    if (!thread || thread.agent !== "claude" || (thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT) !== account || !this.signedOut(threadId)) return;
    const notice = `Claude Code could not read the sign-in for ${claudeAccounts.get(db, account).name} as it started. The account is signed in, so OpenOrc tried again. Continue where you left off.`;
    await this.deps.threads.continueThread(threadId, { ...continuation(thread, account, notice), onCreated: (run) => this.retries.add(run.id) });
  }
}
