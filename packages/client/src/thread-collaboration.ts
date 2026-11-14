import type { ThreadCollaboration, ThreadPerson, ThreadSummary } from "@openorc/protocol";

/**
 * Working together in an OpenOrc Cloud thread, in words, from what the server told the reader. The server decides who
 * may write, stop or answer; nothing here infers that from the creator, the provider or a role. One seam stays: today's
 * server keeps shared writing closed for everyone while its older rule still takes the creator's own messages, so the
 * creator writes as before until the server opens writing or names a block of its own (`writesAsCreator`).
 *
 * A thread nobody else is in reads as it always did: names and the words that tell people apart show only when someone
 * other than the reader is in it (`withOthers`).
 */

type Row = Pick<ThreadSummary, "owner">;

/** The thread's collaboration as the reader's list last heard it; null for a thread not on OpenOrc Cloud, or an older server. */
export function threadTogether(thread: Row | null | undefined): ThreadCollaboration | null {
  return thread?.owner?.brain === "hosted" ? (thread.owner.collaboration ?? null) : null;
}

/** What a person is called here; someone whose account is gone is a former member. */
export function personName(person: ThreadPerson | null): string {
  return person?.name.trim() || "Former member";
}

/** A person's first name, for the short words: a turn's head, "Mara's turn". */
export function personFirst(person: ThreadPerson | null): string {
  return person ? (personName(person).split(/\s+/)[0] ?? personName(person)) : "Former member";
}

const other = (state: ThreadCollaboration, person: ThreadPerson | null | undefined) => person !== undefined && person?.id !== state.viewer.id;

/** Someone besides the reader is in the thread: a teammate started it, sends the live turn, asked, or waits in the queue. */
export function withOthers(thread: Row | null | undefined): boolean {
  if (thread?.owner?.startedBy) return true;
  const state = threadTogether(thread);
  if (!state) return false;
  return [state.live?.sender, state.ask?.sender, ...state.queue.map((queued) => queued.author)].some((person) => other(state, person));
}

/** The reader started the thread and writes under the server's older rule, which shared writing has not opened yet. */
export function writesAsCreator(thread: Row | null | undefined): boolean {
  const state = threadTogether(thread);
  return Boolean(state && !thread?.owner?.startedBy && !state.canWrite && !state.handoff);
}

/**
 * The header's and row's words for whose turn or ask it is, when the thread has someone else in it; null when the plain
 * words say it ("Working", "Needs you"). A turn is its sender's: theirs, or the reader's own; a live ask is its sender's to answer, and calls
 * only them; a parked ask, or one whose sender's account is gone, waits for whoever answers first.
 */
export function togetherActivity(thread: Pick<ThreadSummary, "activity" | "owner">): { text: string; tone: "live" | "attention" | "muted" } | null {
  const state = threadTogether(thread);
  if (!state || !withOthers(thread)) return null;
  const sender = state.live?.sender;
  if (thread.activity === "running" && sender) return { text: other(state, sender) ? `${personFirst(sender)}'s turn` : "Your turn", tone: "live" };
  if (thread.activity !== "waiting" || !state.ask) return null;
  const asker = state.ask.sender;
  if (state.ask.state === "parked" || !asker) return { text: "Waiting for an answer", tone: "muted" };
  return other(state, asker) ? { text: `Waiting on ${personFirst(asker)}`, tone: "muted" } : { text: "Needs your answer", tone: "attention" };
}

/** Why this reader cannot run the agent here now, in the server's words where it has them. Null when they can. */
export function threadWriteBlock(thread: Row | null | undefined): string | null {
  const state = threadTogether(thread);
  if (!state || writesAsCreator(thread)) return null;
  if (state.canWrite && state.send !== "blocked") return null;
  if (state.handoff) return state.handoff.message;
  const starter = thread?.owner?.startedBy?.name.trim().split(/\s+/)[0];
  return starter ? `Only ${starter} can run the agent in this cloud thread for now.` : "The agent can't run in this cloud thread for now.";
}

/** Why this reader cannot answer the thread's ask now: the server's reason, else the words for why no turn can start. */
export function askAnswerBlock(thread: Row | null | undefined): string | null {
  const state = threadTogether(thread);
  const ask = state?.ask;
  if (!state || !ask || ask.answer !== "blocked" || writesAsCreator(thread)) return null;
  if (ask.reason) return ask.reason;
  if (ask.state === "waiting") return `${personFirst(ask.sender)} can answer while this turn is running.`;
  return threadWriteBlock(thread) ?? "This request can't be answered from here.";
}

/** A queued message's author and what the reader may do to it; null when the server named none for it. */
export function queuedBy(thread: Row | null | undefined, messageId: string): { author: ThreadPerson | null; canEdit: boolean; canRemove: boolean; paused: boolean; canStart: boolean } | null {
  const queued = threadTogether(thread)?.queue.find((each) => each.messageId === messageId);
  return queued ? { author: queued.author, canEdit: queued.canEdit, canRemove: queued.canRemove, paused: queued.paused, canStart: queued.canStart } : null;
}

/** What each way to send costs, said on demand on its control in a thread others are in; null where today's words stand. */
export interface SendPayer {
  now: string | null;
  queue: string | null;
  send: string | null;
  stop: string | null;
}

/**
 * Whose sign-in and hours each way uses, when it is not plainly the reader's own: Send now joins a teammate's running
 * turn on its sender, Queue starts the reader's own turn after it, Stop stops the teammate's turn, and Send with nothing
 * running starts the reader's own. Only in a thread others are in, and only where the reader may write.
 */
export function sendPayer(thread: Row | null | undefined): SendPayer | null {
  const state = threadTogether(thread);
  if (!state || !withOthers(thread) || threadWriteBlock(thread) || writesAsCreator(thread)) return null;
  if (!state.live) return { now: null, queue: null, send: "Uses your sign-in and hours.", stop: null };
  if (!other(state, state.live.sender)) return null;
  const first = personFirst(state.live.sender);
  return { now: `Joins ${first}'s turn, on their sign-in and hours.`, queue: `After ${first}'s turn, using your sign-in and hours.`, send: null, stop: `Stop ${first}'s turn` };
}

/** Why a turn takes no message now while the server holds the reader's for the next one: it is stopping. */
export function steerBlock(thread: Row | null | undefined): string | null {
  const state = threadTogether(thread);
  return state?.live && state.send === "after" && !writesAsCreator(thread) ? "This turn is stopping." : null;
}

/** Why the reader cannot start their own paused message now: a turn runs, or the server's block. Null when they can. */
export function startBlock(thread: Row | null | undefined): string | null {
  const state = threadTogether(thread);
  if (!state) return null;
  if (state.live) return "A turn is running. Wait for it to finish.";
  return state.handoff?.message ?? null;
}

/** Whether the server lets this reader stop the running turn; undefined where today's rule decides. */
export function canStopTurn(thread: Row | null | undefined): boolean | undefined {
  const state = threadTogether(thread);
  return state && !writesAsCreator(thread) ? state.canStop : undefined;
}
