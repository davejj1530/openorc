import type { Thread } from "./stand-in-threads.js";

type Reply = { status: number; body: unknown };

/**
 * Fork, as the server takes it: a new thread of the asker's own, under the id the app chose, titled for its parent, on
 * a branch named after the parent's, carrying the parent's log as it stands. Asked again with the same id by the same
 * person it is the same fork; by anyone else, a conflict.
 */
export class StandInForks {
  /** Every fork made, by its id: the parent it came from and who asked. */
  readonly made = new Map<string, { parentId: string; who: string }>();

  take(parent: Thread, who: string, body: Record<string, unknown>, make: (id: string) => Thread): Reply & { fork?: Thread } {
    const id = typeof body["id"] === "string" ? body["id"] : "";
    if (!id) return { status: 400, body: { message: "A fork needs an id.", statusCode: 400 } };
    const before = this.made.get(id);
    if (before && (before.parentId !== parent.id || before.who !== who)) return { status: 409, body: { message: "That fork id belongs to another thread.", statusCode: 409 } };
    const fork = make(id);
    if (!before) {
      this.made.set(id, { parentId: parent.id, who });
      fork.events = parent.events.map((event) => ({ ...event }));
    }
    return { status: 200, body: null, fork };
  }
}
