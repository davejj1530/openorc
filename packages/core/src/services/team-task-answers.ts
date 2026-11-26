import { threads, type Db } from "@openorc/db";
import type { Hosted } from "@openorc/hosted";
import type { Logger } from "../transport.js";
import type { ThreadService } from "./threads.js";

type Dependencies = {
  db: Db;
  account: () => Pick<Hosted, "taskAnswers"> | null;
  threads: Pick<ThreadService, "queue">;
  log: Logger;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Answers to updates this computer's agents posted on team tasks: each passed to its agent's thread here as the reply
 * chosen, as an answer to an update on a task kept here is, and marked delivered so it is passed once. It looks on a
 * notice for this person and on each new connection, which may have come after this computer was off.
 */
export class TeamTaskAnswers {
  private unsubscribe: (() => void) | null = null;
  private readonly looking = new Map<string, Promise<void>>();

  constructor(private readonly deps: Dependencies) {}

  start(): void {
    const account = this.deps.account();
    if (!account || this.unsubscribe) return;
    this.unsubscribe = account.taskAnswers.onWaiting((spaceId) => void this.check(spaceId));
    for (const spaceId of account.taskAnswers.organizations()) void this.check(spaceId);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Passes on what waits in an organization; asked while it looks, it joins that look. */
  check(spaceId: string): Promise<void> {
    const current = this.looking.get(spaceId);
    if (current) return current;
    const look = this.look(spaceId)
      .catch((error: unknown) => this.deps.log.warn(`team task answers: a look in ${spaceId} failed: ${errorText(error)}`))
      .finally(() => this.looking.delete(spaceId));
    this.looking.set(spaceId, look);
    return look;
  }

  private async look(spaceId: string): Promise<void> {
    const account = this.deps.account();
    if (!account) return;
    for (const answer of await account.taskAnswers.waiting(spaceId)) {
      const thread = threads.get(this.deps.db, answer.threadId);
      // A thread deleted here has nobody to tell; the answer is delivered all the same, so it is not asked again.
      if (thread && !thread.archivedAt) this.deps.threads.queue(thread.id, answer.reply);
      await account.taskAnswers.delivered(spaceId, answer.reportId);
    }
  }
}
