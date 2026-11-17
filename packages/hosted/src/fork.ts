import type { RpcParams, RpcResults } from "@openorc/protocol";
import { Refused, type Session } from "./session.js";
import { wireMessageId } from "./translate.js";
import { ROUTES, type WireThread } from "./wire.js";

/** What a fork needs of the thread catalog: the parent as last heard, and a way to list the new thread at once. */
export interface ForkHost {
  session: Session;
  heard(threadId: string): { space: string } | null;
  listNew(row: WireThread & { space: string }): RpcResults["threads.fork"];
}

/**
 * threads.fork: a fork of a cloud thread, a new thread of the asker's own on the server, which carries on the
 * conversation from a turn's end with a copy of the work on a branch of its own. It lists at once; its copy lands as
 * soon as it can. Asking again with the same request key is the same fork.
 */
export async function forkThread(host: ForkHost, { id, requestKey }: RpcParams<"threads.fork">): Promise<RpcResults["threads.fork"]> {
  const parent = host.heard(id);
  if (!parent) throw new Refused("That conversation isn't available on OpenOrc Cloud.");
  const generation = host.session.generation;
  const forked = await host.session.in(parent.space).request(ROUTES.fork(id), { id: wireMessageId(requestKey) ?? crypto.randomUUID() });
  if (generation !== host.session.generation) throw new Refused("Your OpenOrc session changed. Try again.");
  return host.listNew({ ...forked, space: parent.space });
}
