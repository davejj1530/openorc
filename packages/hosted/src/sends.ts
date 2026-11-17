/**
 * Every way a window writes to a hosted thread: the composer's sends, the queue, Stop, an answer to an ask, and the
 * word that a person is about to write. The server has one verb for a message and decides itself whether it starts a
 * turn, joins the running one, or waits, so the window's three ways to send all end in `post`.
 *
 * A refusal to start a turn is a normal answer from the server, not an error. It makes the account be read again, so
 * the card above the composer says why, and the send fails with the same words, which keeps the message in the
 * composer. After every write the rows are read again before the answer, so the window's next read sees it.
 */
import {
  hostedSendBlock,
  hostedThreadOf,
  isHostedAgent,
  isHostedRefusal,
  type AccountStatus,
  type HostedRefusal,
  type OnlineTaskSendContext,
  type QueuedMessage,
  type RpcParams,
} from "@openorc/protocol";
import { Refused, type Requests } from "./session.js";
import { refusalWords, toQueued, wireMessageId } from "./translate.js";
import { ROUTES, type WireThread } from "./wire.js";
import { messageFileIds } from "./message-files.js";

/** The settings one turn runs with, as the server names them; any left out are the thread's own. */
export type TurnSettings = Partial<WireThread["settings"]>;

/** What a write works with, given by threads.ts. */
export interface Calls {
  /** Requests about a thread, in its space. */
  on(threadId: string): Requests;
  /** The row, or a rejection in words when the account no longer has it. */
  row(threadId: string): WireThread;
  /** A teammate's thread the person only reads: its starter writes to it, until the server lets teammates write. */
  readOnly(threadId: string): boolean;
  /** Reads the rows again, and resolves once they are heard. */
  refresh(): Promise<void>;
  account(): AccountStatus;
  /** The server refused a turn for this reason: the account is read again, and a dead sign-in remembered. */
  refused(refusal: HostedRefusal, settings: { agent: string; model: string | null }): void;
  /** Makes the person's own skills for `agent` the server's (skills.ts). It rejects in words when they could not be sent. */
  bring(threadId: string, agent: string): Promise<void>;
  now(): number;
}

const GONE = "That conversation isn't on OpenOrc Cloud.";
/** How often the person writing may ask the thread to be ready: a thread's machine rests two minutes before it sleeps. */
const READY_AGAIN_MS = 60_000;

const threadOf = (runId: string): string => {
  const threadId = hostedThreadOf(runId);
  if (threadId === null) throw new Refused(GONE);
  return threadId;
};

/** The settings a turn would run with: the thread's, with what this message asks instead. */
const turnSettings = (row: WireThread, asked: TurnSettings | undefined) => ({ agent: asked?.agent ?? row.settings.agent, model: asked?.model !== undefined ? asked.model : row.settings.model });

/**
 * One message to the thread, under the window's id when it names one, so the bubble it shows is the stored message and
 * sending again is the same message. `after`: wait for the running turn to end.
 */
async function post(
  calls: Calls,
  threadId: string,
  message: {
    id?: string | undefined;
    text: string;
    attachments?: readonly string[] | undefined;
    settings?: TurnSettings;
    after?: boolean;
    task?: OnlineTaskSendContext | undefined;
    /** The turn the sender saw running, when they are not at this Mac: a phone's screen can be older than the row. */
    expectedTurnId?: string | undefined;
  },
): Promise<void> {
  const row = calls.row(threadId);
  const fileIds = await messageFileIds(calls.on(threadId), message.attachments);
  if (message.settings?.agent && !isHostedAgent(message.settings.agent)) throw new Refused(`${message.settings.agent} doesn't run on OpenOrc Cloud.`);
  // A turn this message starts finds the sender's own skills: one that could not be sent keeps the message here.
  await calls.bring(threadId, turnSettings(row, message.settings).agent);
  const id = wireMessageId(message.id) ?? crypto.randomUUID();
  // Send now joins the turn the window saw live; a server that finds another, or none, keeps it as the author's queue.
  const live = message.after ? null : (message.expectedTurnId ?? row.collaboration?.live?.id ?? null);
  const body = {
    id,
    ...(live && { expectedTurnId: live }),
    text: message.text,
    ...(fileIds.length && { fileIds }),
    ...(message.settings && { settings: message.settings }),
    ...(message.after && { delivery: "after" }),
    ...(message.task && { task: message.task }),
  };
  const reply = await calls.on(threadId).request(ROUTES.send(threadId), body);
  if (!reply.sent) return refuse(calls, reply.refusal, turnSettings(row, message.settings));
  await calls.refresh();
}

/** A refusal: the account is read again, and the write fails with the words the card above the composer shows. */
export function refuse(calls: Calls, refusal: string, settings: { agent: string; model: string | null }): never {
  if (isHostedRefusal(refusal)) calls.refused(refusal, settings);
  throw new Refused(refusalWords(refusal, settings.agent));
}

/** runs.start: the composer's send to a thread whose agent is not running, with the settings the person chose. */
export async function start(calls: Calls, params: RpcParams<"runs.start">): Promise<void> {
  if (!params.threadId) throw new Refused(GONE);
  const settings: TurnSettings = {
    agent: params.agent as WireThread["settings"]["agent"],
    model: params.model ?? null,
    effort: params.effort ?? null,
    mode: params.mode,
    permissionMode: params.permissionMode,
  };
  await post(calls, params.threadId, { id: params.messageId, text: params.prompt, attachments: params.attachments, settings, task: params.task });
}

/** runs.send: into the running turn, or the next turn of a resting agent. The server tells which. */
export function send(calls: Calls, params: RpcParams<"runs.send">): Promise<void> {
  return post(calls, threadOf(params.runId), { id: params.messageId, text: params.text, attachments: params.attachments, task: params.task, expectedTurnId: params.expectedTurnId });
}

/** threads.queue: for after the running turn. Answers the queue as it now stands. */
export async function queue(calls: Calls, params: RpcParams<"threads.queue">): Promise<QueuedMessage[]> {
  await post(calls, params.id, { id: params.requestKey, text: params.text, attachments: params.attachments, after: true, task: params.task });
  return toQueued(calls.row(params.id));
}

/** threads.unqueue: a waiting message leaves the queue, or a refused one is dismissed. */
export async function unqueue(calls: Calls, { id, messageId }: RpcParams<"threads.unqueue">): Promise<QueuedMessage[]> {
  await calls.on(id).request(ROUTES.unsend(id, messageId));
  await calls.refresh();
  return toQueued(calls.row(id));
}

/** threads.sendQueued: the same message again, now: it steers the running turn, or a refused one is tried again. */
export async function sendQueued(calls: Calls, { id, messageId, expectedTurnId }: RpcParams<"threads.sendQueued">): Promise<QueuedMessage[]> {
  const waiting = calls.row(id).waiting.find((message) => message.id === messageId);
  if (!waiting) return toQueued(calls.row(id));
  await post(calls, id, { id: waiting.id, text: waiting.text, expectedTurnId });
  return toQueued(calls.row(id));
}

/**
 * runs.interrupt: the running turn stops, as Stop does on this Mac. Where the server writes shared threads, Stop names
 * the turn the window saw, so a late Stop never stops the next person's turn; the server cancels the stopper's own
 * waiting messages and pauses everyone else's.
 */
export async function stop(calls: Calls, { runId, expectedTurnId }: RpcParams<"runs.interrupt">): Promise<void> {
  const threadId = threadOf(runId);
  const together = calls.row(threadId).collaboration;
  const turnId = expectedTurnId ?? (together?.canWrite ? together.live?.id : undefined);
  await calls.on(threadId).request(ROUTES.stop(threadId), turnId ? { turnId } : undefined);
  await calls.refresh();
}

/**
 * approvals.resolve: an answer to an ask, by its id. An ask whose turn has parked starts a turn when answered, so it can
 * be refused like a send; it then stays open.
 */
/**
 * The ask phase an answer is bound to, so it never continues on someone else's hours by surprise: the one its caller
 * names (a phone names the one its screen showed), else the one this window holds.
 */
function boundPhase(params: RpcParams<"approvals.resolve">, asked: { state: string; turnId: string } | null) {
  const seen = params.expectedState && params.expectedTurnId ? { state: params.expectedState, turnId: params.expectedTurnId } : asked;
  return seen ? { expectedState: seen.state, expectedTurnId: seen.turnId } : {};
}

export async function answer(calls: Calls, params: RpcParams<"approvals.resolve">): Promise<void> {
  const threadId = threadOf(params.runId);
  const row = calls.row(threadId);
  const asked = row.collaboration?.ask?.id === params.approvalId ? row.collaboration.ask : null;
  const bound = boundPhase(params, asked);
  // Words instead of a parked ask of someone else's turn go with the answer, as one continuation of the answerer's own.
  const note = params.note && params.decision === "deny" ? params.note : null;
  const together = Boolean(asked && asked.state === "parked" && asked.sender?.id !== row.collaboration?.viewer?.id);
  // A parked ask's answer starts a turn of the answerer's own, which finds their skills as a message's would.
  if (asked?.state === "parked") await calls.bring(threadId, row.settings.agent);
  const body = { decision: params.decision, ...(params.answers && { answers: params.answers }), ...bound, ...(together && note && { message: note }) };
  const reply = await calls
    .on(threadId)
    .request(ROUTES.answer(params.approvalId), body)
    .catch(async (error: unknown) => {
      // The ask may have changed: the window reads it again, and the person's words stay where they are.
      await calls.refresh();
      throw error;
    });
  if (!reply.answered) return refuse(calls, reply.refusal, turnSettings(row, undefined));
  // A denial's note is the person's next message, as on this Mac: the server joins it to the turn or starts one.
  if (note && !together) return post(calls, threadId, { text: note });
  await calls.refresh();
}

/**
 * threads.ready: the person is about to write. The thread's machine wakes and its agent starts waiting, so the message
 * finds it running. At most once a minute per thread, never for a working thread, which is ready already, and never
 * for one the account says cannot start a turn with these settings, or a teammate's, which the person only reads.
 */
export async function ready(calls: Calls, readied: Map<string, number>, { id, settings }: RpcParams<"threads.ready">): Promise<void> {
  const row = calls.row(id);
  if (settings?.agent && !isHostedAgent(settings.agent)) return;
  if (row.status === "working" || calls.readOnly(id) || hostedSendBlock(calls.account(), turnSettings(row, settings as TurnSettings | undefined), false)) return;
  if (calls.now() - (readied.get(id) ?? Number.NEGATIVE_INFINITY) < READY_AGAIN_MS) return;
  readied.set(id, calls.now());
  // The process that waits is started with the person's skills. A failure here is the send's to say.
  await calls.bring(id, turnSettings(row, settings as TurnSettings | undefined).agent).catch(() => undefined);
  await calls.on(id).request(ROUTES.ready(id), settings ? { settings } : {});
}
