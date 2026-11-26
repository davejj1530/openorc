import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HostedSpaces } from "./index.js";
import { organizationsOf, watchPersonNotices } from "./person-notices.js";
import type { Session } from "./session.js";
import type { OnlineTasks } from "./tasks.js";
import type { Route } from "./wire.js";

/** An answer to an update an agent on this person's computer posted on a team task, for that agent's thread. */
export const WaitingTaskAnswer = z.object({ reportId: z.string(), taskId: z.string(), threadId: z.string(), reply: z.string(), by: z.object({ userId: z.string(), name: z.string() }) });
export type WaitingTaskAnswer = z.infer<typeof WaitingTaskAnswer>;

const ANSWER_ROUTES = {
  waiting: { method: "GET", path: "/task-answers", reply: z.array(WaitingTaskAnswer) } satisfies Route<WaitingTaskAnswer[]>,
  delivered: (reportId: string): Route<unknown> => ({ method: "POST", path: `/task-answers/${encodeURIComponent(reportId)}/delivered`, reply: z.unknown() }),
};

type Dependencies = { session: Session; spaces: Pick<HostedSpaces, "status">; tasks: Pick<OnlineTasks, "state"> };

/**
 * The answers teammates gave to updates agents on this person's computer posted on team tasks, which wait on the
 * server until this computer has passed each to its agent's thread; and a call when there may be some.
 */
export class TaskAnswers {
  readonly #listeners = new Set<(spaceId: string) => void>();

  constructor(private readonly deps: Dependencies) {
    watchPersonNotices(deps.session, deps.spaces, "task-answers", (spaceId) => this.#listeners.forEach((listener) => listener(spaceId)));
  }

  onWaiting(listener: (spaceId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  organizations(): string[] {
    return organizationsOf(this.deps.spaces);
  }

  /** The answers waiting for this computer's agents in an organization; none where the server keeps no updates. */
  async waiting(spaceId: string): Promise<WaitingTaskAnswer[]> {
    const state = await this.deps.tasks.state({ spaceId });
    if (state.state !== "ready" || !state.reports) return [];
    return this.deps.session.in(spaceId).request(ANSWER_ROUTES.waiting);
  }

  /** Says the answer reached its agent's thread here, so it is not passed again. */
  async delivered(spaceId: string, reportId: string): Promise<void> {
    await this.deps.session.in(spaceId).request(ANSWER_ROUTES.delivered(reportId), { requestId: randomUUID() });
  }
}
