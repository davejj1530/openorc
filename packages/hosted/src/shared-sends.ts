/**
 * The writes working together adds to a hosted thread: an author starting their own paused message, and asking the
 * server to save the thread's work again. Each is the server's to allow; it answers in its own words when it does not.
 */
import type { RpcParams } from "@openorc/protocol";
import { refuse, type Calls } from "./sends.js";
import { COLLABORATION_ROUTES } from "./wire-collaboration.js";

/**
 * threads.startQueued: the author's paused message starts their own turn. Every explicit Start has its own request id,
 * kept until the server answers, so pressing again after a lost reply is the same Start and never a second turn.
 */
export async function startQueued(calls: Calls & { starts: Map<string, string> }, { threadId, messageId }: RpcParams<"threads.startQueued">): Promise<null> {
  const row = calls.row(threadId);
  const key = `${threadId}:${messageId}`;
  const requestId = calls.starts.get(key) ?? crypto.randomUUID();
  calls.starts.set(key, requestId);
  const reply = await calls.on(threadId).request(COLLABORATION_ROUTES.startQueued(threadId, messageId), { requestId });
  calls.starts.delete(key);
  if (!reply.sent) return refuse(calls, reply.refusal, { agent: row.settings.agent, model: row.settings.model });
  await calls.refresh();
  return null;
}

/** threads.retrySave: the server saves the thread's work again; the row's blocker says how it went. */
export async function retrySave(calls: Calls, { threadId }: RpcParams<"threads.retrySave">): Promise<null> {
  await calls.on(threadId).request(COLLABORATION_ROUTES.retrySave(threadId), {});
  await calls.refresh();
  return null;
}
