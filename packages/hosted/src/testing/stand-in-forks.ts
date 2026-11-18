import type { StandInThreadSeed, Thread } from "./stand-in-thread-types.js";

type Reply = { status: number; body: unknown };

/**
 * Fork, as the server takes it: a new thread of the asker's own, under the id the app chose, titled for its parent, on
 * a branch named after the parent's, carrying the parent's log as it stands. Asked again with the same id by the same
 * person it is the same fork; by anyone else, a conflict.
 */
export class StandInForks {
  /** Every fork made, by its id: the parent it came from and who asked. */
  readonly made = new Map<string, { parentId: string; who: string }>();

  constructor(private readonly threads: { held(id: string): Thread | undefined; add(who: string, seed: StandInThreadSeed): string; row(thread: Thread, who: string): unknown }) {}

  take(parent: Thread, who: string, body: Record<string, unknown>): Reply {
    const id = typeof body["id"] === "string" ? body["id"] : "";
    if (!id) return { status: 400, body: { message: "A fork needs an id.", statusCode: 400 } };
    const before = this.made.get(id);
    if (before && (before.parentId !== parent.id || before.who !== who)) return { status: 409, body: { message: "That fork id belongs to another thread.", statusCode: 409 } };
    if (!before) {
      this.made.set(id, { parentId: parent.id, who });
      const seed = {
        id,
        projectId: parent.projectId,
        title: `${parent.title || "Thread"} (fork)`,
        branch: `${parent.branch}-fork-${id.slice(0, 8)}`,
        agent: parent.agent as StandInThreadSeed["agent"],
      };
      this.threads.held(this.threads.add(who, seed))!.events = parent.events.map((event) => ({ ...event }));
    }
    return { status: 200, body: this.threads.row(this.threads.held(id)!, who) };
  }
}
