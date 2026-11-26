import { randomUUID } from "node:crypto";
import { BoardColumnJob, OnlineTaskRun } from "@openorc/protocol";
import { z } from "zod";
import type { HostedSpaces } from "./index.js";
import type { Session } from "./session.js";
import type { OnlineTasks } from "./tasks.js";
import { wireOnlineTask } from "./wire-tasks.js";
import { organizationsOf, watchPersonNotices } from "./person-notices.js";
import type { Route } from "./wire.js";

const date = z.iso.datetime().transform((value) => Date.parse(value));
const wireRun = OnlineTaskRun.extend({ requestedAt: z.union([z.number(), date]) });

/**
 * A team board's column agent waiting for this person's computer: the run, the task as it stands, and the column with
 * what its agent is told, the column it hands the card to, and the one the card came from.
 */
export const WaitingTaskRun = z.object({
  run: wireRun,
  task: wireOnlineTask,
  column: z.object({ id: z.string(), name: z.string(), job: BoardColumnJob, nextColumnName: z.string().nullable() }),
  fromColumnName: z.string().nullable(),
});
export type WaitingTaskRun = z.infer<typeof WaitingTaskRun>;

const claimed = z.discriminatedUnion("state", [z.object({ state: z.literal("claimed"), run: wireRun }), z.object({ state: z.literal("gone") })]);
const RUN_ROUTES = {
  waiting: { method: "GET", path: "/task-runs", reply: z.array(WaitingTaskRun) } satisfies Route<WaitingTaskRun[]>,
  claim: (id: string): Route<z.infer<typeof claimed>> => ({ method: "POST", path: `/task-runs/${encodeURIComponent(id)}/claim`, reply: claimed }),
  report: (id: string): Route<z.infer<typeof wireRun>> => ({ method: "POST", path: `/task-runs/${encodeURIComponent(id)}/report`, reply: wireRun }),
};

type Dependencies = { session: Session; spaces: Pick<HostedSpaces, "status">; tasks: Pick<OnlineTasks, "state"> };

/**
 * The column agents of team boards that wait for this person's computer, read and claimed in each organization. One is
 * asked of them when a card lands in its column, and waits on the server until one of their computers claims it; this
 * says when there may be some: a notice for this person, and a new connection, which may have missed notices.
 */
export class TaskRuns {
  readonly #listeners = new Set<(spaceId: string) => void>();

  constructor(private readonly deps: Dependencies) {
    watchPersonNotices(deps.session, deps.spaces, "task-runs", (spaceId) => this.#emit([spaceId]));
  }

  /** Called with an organization that may have runs waiting for this computer. */
  onWaiting(listener: (spaceId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The organizations this person is in, whose runs may wait for them. */
  organizations(): string[] {
    return organizationsOf(this.deps.spaces);
  }

  /** The runs waiting for this person in an organization; none where its server runs no column agents. */
  async waiting(spaceId: string): Promise<WaitingTaskRun[]> {
    const state = await this.deps.tasks.state({ spaceId });
    if (state.state !== "ready" || !state.runs) return [];
    return this.deps.session.in(spaceId).request(RUN_ROUTES.waiting);
  }

  /** Takes a run for this computer; gone when another of the person's computers took it, or the card moved on. */
  async claim(spaceId: string, id: string): Promise<boolean> {
    return (await this.deps.session.in(spaceId).request(RUN_ROUTES.claim(id), { requestId: randomUUID() })).state === "claimed";
  }

  /** Says this computer has no folder for the run's project, which its card shows. */
  async noFolder(spaceId: string, id: string): Promise<void> {
    await this.deps.session.in(spaceId).request(RUN_ROUTES.report(id), { requestId: randomUUID(), state: "no_folder" });
  }

  /** Says the run's agent finished its turn here, so its card stops saying it runs. */
  async finished(spaceId: string, id: string): Promise<void> {
    await this.deps.session.in(spaceId).request(RUN_ROUTES.report(id), { requestId: randomUUID(), state: "finished" });
  }

  #emit(spaceIds: readonly string[]): void {
    for (const spaceId of spaceIds) for (const listener of this.#listeners) listener(spaceId);
  }
}
