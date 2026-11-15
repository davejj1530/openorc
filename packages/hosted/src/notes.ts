/**
 * A hosted thread's notes: threads.notes reads a page of them, threads.postNote posts one. A note is for the people it
 * tags and never reaches the agent as a message, so posting one asks for no readiness, wakes nothing and starts no turn.
 * The server checks every tag again and refuses in its own words, which the window shows as they are.
 */
import type { RpcParams, RpcResults } from "@openorc/protocol";
import type { Threads } from "./threads.js";
import { COLLABORATION_ROUTES, toNote } from "./wire-collaboration.js";

/** threads.notes: the newest page, or the one after or before a note's `seq`, or around one note. */
export async function notes(threads: Threads, { threadId, after, before, around, limit }: RpcParams<"threads.notes">): Promise<RpcResults["threads.notes"]> {
  const query = new URLSearchParams();
  if (after !== undefined) query.set("after", String(after));
  else if (before !== undefined) query.set("before", String(before));
  else if (around !== undefined) query.set("around", around);
  if (limit !== undefined) query.set("limit", String(limit));
  const page = await threads.on(threadId).request(COLLABORATION_ROUTES.notes(threadId, query));
  return { ...page, notes: page.notes.map(toNote) };
}

/** threads.postNote: the note as the server stored it. Every window, this one included, hears it as the thread's change. */
export async function postNote(threads: Threads, { threadId, ...note }: RpcParams<"threads.postNote">): Promise<RpcResults["threads.postNote"]> {
  const posted = await threads.on(threadId).request(COLLABORATION_ROUTES.postNote(threadId), note);
  return { note: toNote(posted.note) };
}
