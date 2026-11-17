import type { ThreadCollaboration, ThreadHandoffNote, ThreadPerson, ThreadSummary } from "@openorc/protocol";

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

/**
 * Whether a row's state slot shows the reader's unread mention, a note in the thread that tags them. An ask that needs
 * them, a failure, and work under way (a turn, or commands left running) keep their marks; the mention stands before a
 * quiet wait or an unread result. Only this Mac's row draws it: the shared status that the phone also reads is left as it
 * was.
 */
export function mentionLeads(thread: Row | null | undefined, status: { kind: string } | null): boolean {
  if (!threadTogether(thread)?.mentions.unread) return false;
  return !status || status.kind === "unread" || status.kind === "waiting-other";
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

/** The one move a handoff block offers its reader: release it, or, with nothing else to press, ask the person who can. */
export type HandoffAction = { kind: "retry-save" } | { kind: "stop-commands"; commandIds: string[] } | { kind: "stop-work" } | { kind: "note"; note: ThreadHandoffNote };

/** A handoff's move, as its button says it: a cloud thread's terminal is held in the same block as a command, and named for what it is. */
export function handoffLabel(action: HandoffAction): string {
  if (action.kind === "note") return `Tag ${personFirst(action.note.to)}`;
  if (action.kind === "retry-save") return "Retry save";
  if (action.kind === "stop-work") return "Stop work";
  if (action.commandIds.length > 0 && action.commandIds.every((id) => id.startsWith("terminal-"))) return action.commandIds.length > 1 ? "Stop terminals" : "Stop terminal";
  return action.commandIds.length > 1 ? "Stop commands" : "Stop command";
}

const SAVE_FAILED = "The thread's work could not be saved.";

/**
 * The card for what keeps a turn from starting here: the server's words, and the move that releases it where the reader
 * may make it. Retry save goes to the person the server lets ask for it, shown even when they may still run here
 * themselves, and they are not told that they can, since the button says it. Stop goes with a command still running
 * from the previous sender's turn, and Stop work with work that reports back, for one of the thread's people. A reader
 * with nothing else to press gets the server's note to the person who can.
 * Otherwise the card shows only while it keeps the reader from starting a turn: a running turn takes their message,
 * which no handoff holds.
 */
export function handoffCard(thread: Row | null | undefined): { words: string; action: HandoffAction | null } | null {
  const state = threadTogether(thread);
  const block = state?.handoff;
  if (!state || !block || writesAsCreator(thread)) return null;
  if (block.retrySave) return { words: block.responsible?.id === state.viewer.id ? SAVE_FAILED : block.message, action: { kind: "retry-save" } };
  if (!threadWriteBlock(thread)) return null;
  if (block.code === "handoff_command" && block.commandIds.length > 0) return { words: block.message, action: { kind: "stop-commands", commandIds: block.commandIds } };
  if (block.stopWork) return { words: block.message, action: { kind: "stop-work" } };
  return { words: block.message, action: block.note ? { kind: "note", note: block.note } : null };
}

/**
 * A parked ask the reader may answer, in a thread others are in, starts the reader's own turn: its answer is confirmed,
 * and what it uses is said on demand. Null for any other ask, and in a thread nobody else is in, which answers as before.
 */
export function askContinues(thread: Row | null | undefined, approvalId: string): string | null {
  const ask = threadTogether(thread)?.ask;
  if (!ask || ask.id !== approvalId || ask.state !== "parked" || ask.answer !== "start" || !withOthers(thread)) return null;
  return "Continues with your sign-in and hours.";
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

/**
 * Whether the server lets this reader stop the commands and terminals the thread keeps running; undefined where today's
 * rule decides. Whoever may write here stops them, even while a handoff holds their own turn: one of the thread's people
 * stops any, and anyone else the ones the block names, which are all it keeps running.
 */
export function canStopCommands(thread: Row | null | undefined): boolean | undefined {
  const state = threadTogether(thread);
  return state && !writesAsCreator(thread) ? state.canWrite : undefined;
}
