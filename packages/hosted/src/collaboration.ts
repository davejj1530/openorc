/**
 * The app's reads of working together in a hosted thread: threads.collaboration, threads.authors and threads.people.
 * The server decides every capability; nothing here infers one from the creator, the provider or a role.
 */
import type { RpcParams, RpcResults, ThreadCollaboration } from "@openorc/protocol";
import { Refused } from "./session.js";
import type { Threads } from "./threads.js";
import { COLLABORATION_ROUTES, toCollaboration, toPerson } from "./wire-collaboration.js";

/** The words a 404 for a thread the server no longer has is in; any other 404 is a server without the read. */
const GONE = "That thread isn't here.";

/** The collaboration the reader's list last heard on the thread's row; null from a server that predates it. */
export function heardCollaboration(threads: Threads, threadId: string): ThreadCollaboration | null {
  const wire = threads.row(threadId).collaboration;
  return wire ? toCollaboration(wire) : null;
}

/**
 * threads.collaboration: the thread's collaboration now. A server that does not serve it answers unsupported, which keeps
 * the read-only teammate view; a failure to reach it is a failure, never unsupported.
 */
export async function collaboration(threads: Threads, { threadId }: RpcParams<"threads.collaboration">): Promise<RpcResults["threads.collaboration"]> {
  try {
    const state = toCollaboration(await threads.on(threadId).request(COLLABORATION_ROUTES.collaboration(threadId)));
    return state ? { supported: true, state } : { supported: false };
  } catch (error) {
    if (error instanceof Refused && error.status === 404 && error.message !== GONE) return { supported: false };
    throw error;
  }
}

/** threads.authors: who sent each turn and wrote each message of the log read so far. None from an older server. */
export async function authors(threads: Threads, { threadId }: RpcParams<"threads.authors">): Promise<RpcResults["threads.authors"]> {
  const row = threads.row(threadId);
  const state = heardCollaboration(threads, threadId);
  if (!state) return { viewer: null, turnOf: {}, senders: {}, authors: {} };
  threads.voices.meet(state, row.startedBy ? toPerson(row.startedBy) : null);
  return threads.voices.read(threadId, threads.on(threadId), state);
}

/** threads.people: who can be tagged, by name. An address only tells apart people who share a name. */
export async function people(threads: Threads, { threadId, q }: RpcParams<"threads.people">): Promise<RpcResults["threads.people"]> {
  const { people: found } = await threads.on(threadId).request(COLLABORATION_ROUTES.people(threadId, q?.trim() ?? ""));
  const named = (name: string) => name.trim().toLowerCase();
  const counts = new Map<string, number>();
  for (const person of found) counts.set(named(person.name), (counts.get(named(person.name)) ?? 0) + 1);
  return { people: found.map(({ email, ...person }) => ({ ...toPerson(person), address: (counts.get(named(person.name)) ?? 0) > 1 ? email : null })) };
}
