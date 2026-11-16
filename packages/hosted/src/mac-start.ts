/**
 * A cloud thread started from this Mac's project folder (cloud parity unit 5a). What goes is packed on the Mac before
 * anything leaves (core's `macWork`, git's `packMacWork`); here it is sent: the thread is made with no message, the
 * pack goes up as the thread's first save, and only then is the first message sent, so the thread's first turn opens on
 * the Mac's work. A pack that does not arrive leaves no thread behind.
 */
import { z } from "zod";
import { RawBody } from "./raw-body.js";
import type { RpcParams } from "@openorc/protocol";
import { Refused, type Requests } from "./session.js";
import { PARITY_ROUTES } from "./wire-parity.js";
import { ROUTES, type Route } from "./wire.js";

/** A folder's work, packed, as core hands it over: what the server is told, why it can't go, its bytes, and its removal. */
export type MacWorkUpload = {
  query: { base: string; headSha: string; headTreeSha: string; treeSha: string; wip: string };
  refusal: string | null;
  chunks(): AsyncIterable<Uint8Array>;
  done(): Promise<void>;
};

const taken = z.object({ saved: z.literal(true), bytes: z.number().int().nonnegative() });

export const MAC_ROUTES = {
  work: (threadId: string, query: MacWorkUpload["query"]): Route<z.infer<typeof taken>> => ({
    method: "PUT",
    path: `/hosted/threads/${encodeURIComponent(threadId)}/mac-work?${new URLSearchParams(query)}`,
    reply: taken,
  }),
  remove: (threadId: string): Route<null> => ({ method: "DELETE", path: `/hosted/threads/${encodeURIComponent(threadId)}`, reply: null }),
};

/** Whether `space`'s server takes a start from a Mac's folder. A server from before capabilities takes none. */
export async function macStartServed(on: Requests): Promise<boolean> {
  try {
    return (await on.request(PARITY_ROUTES.capabilities)).features.macCode?.available === true;
  } catch (error) {
    if (error instanceof Refused && error.status === 404) return false;
    throw error;
  }
}

/** Sends the pack as the new thread's first save. One that fails removes the thread, so no thread waits on work that never came. */
export async function sendMacWork(on: Requests, threadId: string, upload: MacWorkUpload): Promise<void> {
  try {
    await on.request(MAC_ROUTES.work(threadId, upload.query), new RawBody(() => upload.chunks()));
  } catch (error) {
    await on.request(MAC_ROUTES.remove(threadId)).catch(() => undefined);
    throw error;
  } finally {
    await upload.done();
  }
}

/** The folder's work, packed, when the start asks for it and this Mac can pack; refused in the packer's words before anything leaves. */
export async function packedFor(
  pack: ((projectId: string, include: readonly string[]) => Promise<MacWorkUpload | null>) | undefined,
  params: Pick<RpcParams<"threads.start">, "projectId" | "macWork">,
): Promise<MacWorkUpload | null> {
  const upload = params.macWork && pack ? await pack(params.projectId, params.macWork.include) : null;
  if (upload?.refusal) {
    await upload.done();
    throw new Refused(upload.refusal);
  }
  return upload;
}

type First = { first: { id: string; text: string; fileIds?: string[] } };

/**
 * Makes the thread. With no Mac work, its first message goes with it, as before. With some, the thread is made with no
 * message, the work goes up as its first save, and then the first message is sent; `refusal` is the server's word when
 * that message can't start a turn (the thread stays).
 */
export async function startWith(on: Requests, body: Record<string, unknown>, first: First, settings: unknown, mac: MacWorkUpload | null) {
  if (!mac) return { reply: await on.request(ROUTES.start, { ...body, ...first }), refusal: null };
  const reply = await on.request(ROUTES.start, body).catch(async (error: unknown) => {
    await mac.done();
    throw error;
  });
  if (!reply.thread) {
    await mac.done();
    return { reply, refusal: null };
  }
  await sendMacWork(on, reply.thread.id, mac);
  const sent = await on.request(ROUTES.send(reply.thread.id), { ...first.first, settings });
  return { reply, refusal: sent.sent ? null : sent.refusal };
}
