import type { RpcParams } from "@openorc/protocol";
import { messageFileIds } from "./message-files.js";
import type { Requests } from "./session.js";

/**
 * A new cloud thread's first message, as the create request carries it. With files it goes under the start's request
 * id, which is also the message's, so the start sent again after a lost answer is the same body and the server answers
 * the thread it made. Without files the body is what it always was.
 */
export async function firstMessage(on: Requests, params: Pick<RpcParams<"threads.start">, "prompt" | "attachments" | "requestId">) {
  const fileIds = await messageFileIds(on, params.attachments);
  if (!fileIds.length) return { first: { id: crypto.randomUUID(), text: params.prompt } };
  const id = params.requestId ?? crypto.randomUUID();
  return { requestId: id, first: { id, text: params.prompt, fileIds } };
}
