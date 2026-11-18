import { startTurn } from "./stand-in-thread-placement.js";
import type { Thread } from "./stand-in-thread-types.js";

type Reply = { status: number; body: unknown };

/**
 * Compact, as the server takes it: the agent folds the conversation as the asker's own turn, which starts at once and
 * which tests end with `endTurn`. Refused while a turn runs; asked again with the same id, it is the compaction asked.
 */
export class StandInCompactions {
  /** Every compaction asked, in order. */
  readonly asked: { threadId: string; who: string; body: Record<string, unknown> }[] = [];

  take(thread: Thread, who: string, body: Record<string, unknown>): Reply {
    const again = this.asked.some((each) => each.threadId === thread.id && each.who === who && each.body["id"] === body["id"]);
    this.asked.push({ threadId: thread.id, who, body });
    if (again) return { status: 200, body: { compacting: true } };
    if (thread.turn) return { status: 409, body: { message: "Wait for the current turn to finish before compacting.", statusCode: 409 } };
    startTurn(thread, who);
    thread.status = "working";
    return { status: 200, body: { compacting: true } };
  }
}
