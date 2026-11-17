import type { RpcParams } from "@openorc/protocol";
import { refuse, type Calls } from "./sends.js";
import { wireMessageId } from "./translate.js";
import { ROUTES } from "./wire.js";

/**
 * threads.compact: the agent folds the conversation so far between turns, as Compact does on this Mac. On the server it
 * is the asker's own turn, with the thread's settings: the thread works while it compacts, then says so. Asking again
 * with the same request key is the same compaction.
 */
export async function compact(calls: Calls, { id, requestKey }: RpcParams<"threads.compact">): Promise<null> {
  const row = calls.row(id);
  // The process it starts finds the asker's own skills, as a message's turn does.
  await calls.bring(id, row.settings.agent);
  const reply = await calls.on(id).request(ROUTES.compact(id), { id: wireMessageId(requestKey) ?? crypto.randomUUID() });
  if (!reply.compacting) return refuse(calls, reply.refusal, row.settings);
  await calls.refresh();
  return null;
}
