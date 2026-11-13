/**
 * Every way a window writes to a hosted thread: the composer's sends, the queue, Stop, an answer to an ask, and the
 * word that a person is about to write. The server has one verb for a message and decides itself whether it starts a
 * turn, joins the running one, or waits, so the window's three ways to send all end in `post`.
 *
 * A refusal to start a turn is a normal answer from the server, not an error. It makes the account be read again, so
 * the card above the composer says why, and the send fails with the same words, which keeps the message in the
 * composer. After every write the rows are read again before the answer, so the window's next read sees it.
 */
import { hostedSendBlock, hostedThreadOf, isHostedAgent, isHostedRefusal, type AccountStatus, type HostedRefusal, type QueuedMessage, type RpcParams } from "@openorc/protocol";
import { Refused, type Requests } from "./session.js";
import { refusalWords, toQueued, wireMessageId } from "./translate.js";
import { ROUTES, type WireThread } from "./wire.js";

/** The settings one turn runs with, as the server names them; any left out are the thread's own. */
export type TurnSettings = Partial<WireThread["settings"]>;

/** What a write works with, given by threads.ts. */
export interface Calls {
  /** Requests about a thread, in its space. */
  on(threadId: string): Requests;
  /** The row, or a rejection in words when the account no longer has it. */
  row(threadId: string): WireThread;
  /** A teammate's thread, which the person reads and only its starter writes to. */
  readOnly(threadId: string): boolean;
  /** Reads the rows again, and resolves once they are heard. */
  refresh(): Promise<void>;
  account(): AccountStatus;
  /** The server refused a turn for this reason: the account is read again, and a dead sign-in remembered. */
  refused(refusal: HostedRefusal, settings: { agent: string; model: string | null }): void;
  now(): number;
}

const GONE = "That conversation isn't on OpenOrc Cloud.";
const FILES = "Files can't be sent to OpenOrc Cloud yet.";
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
  message: { id?: string | undefined; text: string; attachments?: readonly string[] | undefined; settings?: TurnSettings; after?: boolean },
): Promise<void> {
  const row = calls.row(threadId);
  if (message.attachments?.length) throw new Refused(FILES);
  if (message.settings?.agent && !isHostedAgent(message.settings.agent)) throw new Refused(`${message.settings.agent} doesn't run on OpenOrc Cloud.`);
  const id = wireMessageId(message.id) ?? crypto.randomUUID();
  const body = { id, text: message.text, ...(message.settings && { settings: message.settings }), ...(message.after && { delivery: "after" }) };
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
  await post(calls, params.threadId, { id: params.messageId, text: params.prompt, attachments: params.attachments, settings });
}

/** runs.send: into the running turn, or the next turn of a resting agent. The server tells which. */
export function send(calls: Calls, params: RpcParams<"runs.send">): Promise<void> {
  return post(calls, threadOf(params.runId), { id: params.messageId, text: params.text, attachments: params.attachments });
}

/** threads.queue: for after the running turn. Answers the queue as it now stands. */
export async function queue(calls: Calls, params: RpcParams<"threads.queue">): Promise<QueuedMessage[]> {
  await post(calls, params.id, { id: params.requestKey, text: params.text, attachments: params.attachments, after: true });
  return toQueued(calls.row(params.id));
}

/** threads.unqueue: a waiting message leaves the queue, or a refused one is dismissed. */
export async function unqueue(calls: Calls, { id, messageId }: RpcParams<"threads.unqueue">): Promise<QueuedMessage[]> {
  await calls.on(id).request(ROUTES.unsend(id, messageId));
  await calls.refresh();
  return toQueued(calls.row(id));
}

/** threads.sendQueued: the same message again, now: it steers the running turn, or a refused one is tried again. */
export async function sendQueued(calls: Calls, { id, messageId }: RpcParams<"threads.sendQueued">): Promise<QueuedMessage[]> {
  const waiting = calls.row(id).waiting.find((message) => message.id === messageId);
  if (!waiting) return toQueued(calls.row(id));
  await post(calls, id, { id: waiting.id, text: waiting.text });
  return toQueued(calls.row(id));
}

/** runs.interrupt: the running turn stops, and messages not taken yet are cancelled, as Stop does on this Mac. */
export async function stop(calls: Calls, { runId }: RpcParams<"runs.interrupt">): Promise<void> {
  const threadId = threadOf(runId);
  await calls.on(threadId).request(ROUTES.stop(threadId));
  await calls.refresh();
}

/**
 * approvals.resolve: an answer to an ask, by its id. An ask whose turn has parked starts a turn when answered, so it can
 * be refused like a send; it then stays open.
 */
export async function answer(calls: Calls, params: RpcParams<"approvals.resolve">): Promise<void> {
  const threadId = threadOf(params.runId);
  const row = calls.row(threadId);
  const reply = await calls.on(threadId).request(ROUTES.answer(params.approvalId), { decision: params.decision, ...(params.answers && { answers: params.answers }) });
  if (!reply.answered) return refuse(calls, reply.refusal, turnSettings(row, undefined));
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
  await calls.on(id).request(ROUTES.ready(id), settings ? { settings } : {});
}
