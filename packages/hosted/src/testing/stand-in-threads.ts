/**
 * The stand-in's hosted threads: projects by person, threads with their logs, and what the real server tells the
 * sockets of people in a thread. It keeps the real server's rules the app depends on:
 *   a thread is read only by the person who started it (the real server makes no other readers yet)
 *   `seq` rises by one per stored event; `eventId` is `${threadId}.${seq}`; `turnEnds` are the seqs of `turn.completed`
 *   a page by turn starts after the end of the turn before it, and `limit` still applies to it
 *   a stored batch goes to the sockets watching the thread as `hosted:events`, after it is stored
 *   a change to a row (status, head, background commands) goes to its reader's sockets as `changed` with `threads`
 *   a message is stored and logged as the person's at once, under the app's id; sending the same id again is the same
 *   message. With no turn running it starts one if the person may (`admit`), else it is refused with nothing stored.
 *   With a turn running it steers it, on that turn's starter, and asks nothing
 *   an ask's `approvalId` is its row id; it stays open when its turn parks, and an answer to a parked ask starts a turn,
 *   so it is admitted like a send; a second answer is a 409
 *   Stop cancels the messages not taken yet and ends the running turn as cancelled
 *   a ready ask from someone who could not start a turn stores nothing
 *   a person's seen position only moves forward, and never past the head
 *
 * Where the real server has nothing yet, it answers as the app's design assumes (app-side/sketch/server-additions.md 4):
 *   `delivery: "after"` waits, unlogged, in `waiting` with `after: true`, and is taken when the turn ends
 *   a pending message sent again with delivery "now" steers at once; a refused one sent again is admitted again
 *   DELETE /hosted/threads/:id/messages/:messageId cancels a pending message or dismisses a refused one
 *   a waiting message the host refuses when its turn comes stays in `waiting` as refused
 */
import { randomUUID } from "node:crypto";

export interface StandInPeer {
  /** The address the socket's token is for, or null once its session ended. */
  who(): string | null;
  watched: Set<string>;
  send(event: string, body: unknown): void;
}

export interface StandInThreadSeed {
  projectId: string | null;
  title: string;
  status?: "idle" | "working" | "needs_answer";
  branch?: string;
  agent?: "claude" | "codex" | "opencode";
  backgroundCommands?: { id: string; description: string }[];
}

interface Stored {
  seq: number;
  turnId: string | null;
  by: string | null;
  event: Record<string, unknown>;
}

/** Whether a person may start a turn with these settings, as billing and their sign-ins say; the refusal when not. */
export type Admit = (who: string, settings: { agent: string; model: string | null }) => string | null;

interface Message {
  id: string;
  author: string;
  text: string;
  state: "pending" | "delivered" | "refused" | "cancelled";
  refusal: string | null;
  after: boolean;
  createdAt: string;
}

interface Ask {
  id: string;
  kind: string;
  detail: string;
  answered: boolean;
  /** Its turn parked: answering it starts a turn. */
  parked: boolean;
}

interface Thread {
  id: string;
  owner: string;
  projectId: string | null;
  title: string;
  branch: string;
  agent: string;
  status: string;
  seenSeq: number;
  backgroundCommands: { id: string; description: string }[];
  stopped: string[];
  events: Stored[];
  messages: Message[];
  asks: Ask[];
  /** Who started the running turn; null between turns. */
  turn: string | null;
  createdAt: string;
  lastActivityAt: string;
}

type Reply = { status: number; body: unknown };

const missing = (): Reply => ({ status: 404, body: { message: "That thread isn't here.", statusCode: 404 } });

const lastAgentSeq = (thread: Thread) => thread.events.findLast((stored) => stored.by === null)?.seq ?? 0;
const headOf = (thread: Thread) => thread.events.at(-1)?.seq ?? 0;
const turnEnds = (thread: Thread) => thread.events.filter((stored) => stored.event["type"] === "turn.completed").map((stored) => stored.seq);
const wire = (thread: Thread, stored: Stored) => ({ seq: stored.seq, turnId: stored.turnId, by: stored.by, event: { ...stored.event, eventId: `${thread.id}.${stored.seq}` } });

/** A thread as the person's list shows it, with every field the real server answers. */
function rowOf(thread: Thread) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentId: null,
    title: thread.title,
    baseBranch: "main",
    branch: thread.branch,
    settings: { agent: thread.agent, model: null, effort: null, mode: "act", permissionMode: "trusted" },
    status: thread.status,
    head: headOf(thread),
    seenSeq: thread.seenSeq,
    lastAgentSeq: lastAgentSeq(thread),
    turn: thread.turn ? { id: `turn-${thread.id}`, startedBy: `user-${thread.turn}`, startedAt: thread.lastActivityAt, state: "running" } : null,
    backgroundCommands: thread.backgroundCommands,
    waiting: thread.messages.filter((message) => message.state === "pending" || message.state === "refused").map(messageOf),
    ask: openAsk(thread) ? { id: openAsk(thread)!.id, kind: openAsk(thread)!.kind, detail: openAsk(thread)!.detail } : null,
    work: { uncommitted: null, unpushed: null, published: false },
    pullRequest: null,
    actions: [],
    createdBy: `user-${thread.owner}`,
    createdAt: thread.createdAt,
    lastActivityAt: thread.lastActivityAt,
  };
}

const openAsk = (thread: Thread) => thread.asks.find((ask) => !ask.answered) ?? null;

function messageOf(message: Message) {
  return {
    id: message.id,
    authorId: `user-${message.author}`,
    text: message.text,
    files: [],
    state: message.state,
    delivery: message.state === "delivered" ? "started" : null,
    refusal: message.refusal,
    after: message.after,
    createdAt: message.createdAt,
  };
}

/** A stretch of the log: from a turn, or after a seq, at most `limit` events, with the head. */
function pageOf(thread: Thread, query: URLSearchParams) {
  const limit = Number(query.get("limit") ?? 500);
  const ends = turnEnds(thread);
  const fromTurn = query.has("fromTurn") ? Math.min(Number(query.get("fromTurn")), ends.length) : undefined;
  const after = fromTurn === undefined ? Number(query.get("after") ?? 0) : (ends[fromTurn - 1] ?? 0);
  const events = thread.events
    .filter((stored) => stored.seq > after)
    .slice(0, limit)
    .map((stored) => wire(thread, stored));
  return { events, head: headOf(thread), ...(fromTurn !== undefined && { fromTurn }) };
}

export class StandInThreads {
  readonly #projects = new Map<string, { id: string; name: string; fullName: string }[]>();
  readonly #threads = new Map<string, Thread>();

  /** Every message body a person posted, in order, as the server took it. */
  readonly sent: { threadId: string; body: Record<string, unknown> }[] = [];
  /** Every ready ask the stand-in stored, in order. */
  readonly readies: { threadId: string; settings: unknown }[] = [];

  constructor(
    private readonly peers: () => Iterable<StandInPeer>,
    private readonly admit: Admit,
  ) {}

  /** The routes under /projects and /hosted, for the person `who`; null for a path that is not one of them. */
  route(method: string, path: string, query: URLSearchParams, who: string, body: Record<string, unknown> = {}): Reply | null {
    const asked = /^\/hosted\/asks\/([^/]+)\/answer$/.exec(path);
    if (asked && method === "POST") return this.#answer(who, decodeURIComponent(asked[1]!), body);
    const write = /^\/hosted\/threads\/([^/]+)\/(messages|stop|ready|seen)(?:\/([^/]+))?$/.exec(path);
    if (write) return this.#write(method, write, who, body);
    return this.#read(method, path, query, who);
  }

  /** The lists, one thread, its log, and a background command's stop. */
  #read(method: string, path: string, query: URLSearchParams, who: string): Reply | null {
    if (method === "GET" && path === "/projects") return { status: 200, body: (this.#projects.get(who) ?? []).map((project) => ({ ...project, repoId: 1, defaultBranch: "main", connected: true })) };
    if (method === "GET" && path === "/hosted/threads") {
      const mine = [...this.#threads.values()].filter((thread) => thread.owner === who).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
      return { status: 200, body: { threads: mine.map(rowOf) } };
    }
    const match = /^\/hosted\/threads\/([^/]+)(\/events|\/commands\/([^/]+)\/stop)?$/.exec(path);
    if (!match) return null;
    const thread = this.#readable(who, decodeURIComponent(match[1]!));
    if (!thread) return missing();
    if (method === "GET" && !match[2]) return { status: 200, body: { ...rowOf(thread), turnEnds: turnEnds(thread) } };
    if (method === "GET" && match[2] === "/events") return { status: 200, body: pageOf(thread, query) };
    if (method !== "POST" || !match[3]) return null;
    thread.stopped.push(decodeURIComponent(match[3]));
    return { status: 204, body: null };
  }

  /** A thread's messages, its Stop and its ready ask: `[path, threadId, verb, messageId?]`. */
  #write(method: string, [, threadId, verb, messageId]: RegExpExecArray, who: string, body: Record<string, unknown>): Reply | null {
    const thread = this.#readable(who, decodeURIComponent(threadId!));
    if (!thread) return missing();
    const key = `${method} ${verb}${messageId ? "/:id" : ""}`;
    if (key === "POST messages") return this.#send(thread, who, body);
    if (key === "DELETE messages/:id") return this.#unsend(thread, decodeURIComponent(messageId!));
    if (key === "POST stop") return this.#stop(thread);
    if (key === "POST ready") return this.#ready(thread, who, body);
    if (key === "POST seen") {
      thread.seenSeq = Math.max(thread.seenSeq, Math.min(Number(body["seq"] ?? 0), headOf(thread)));
      this.#changed(thread);
      return { status: 200, body: { seenSeq: thread.seenSeq } };
    }
    return null;
  }

  #send(thread: Thread, who: string, body: Record<string, unknown>): Reply {
    this.sent.push({ threadId: thread.id, body });
    const id = String(body["id"] ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return { status: 400, body: { message: "Invalid input: expected uuid", statusCode: 400 } };
    const settings = { ...this.#settings(thread), ...(body["settings"] as object | undefined) };
    const after = body["delivery"] === "after";
    const known = thread.messages.find((message) => message.id === id);
    if (known) return this.#again(thread, known, who, settings, after);
    if (!thread.turn || !after) {
      const refusal = thread.turn ? null : this.admit(who, settings);
      if (refusal) return { status: 200, body: { sent: false, refusal } };
    }
    const message: Message = { id, author: who, text: String(body["text"] ?? ""), state: "pending", refusal: null, after: Boolean(thread.turn) && after, createdAt: new Date().toISOString() };
    thread.messages.push(message);
    if (!message.after) this.#take(thread, message);
    else this.#changed(thread);
    return { status: 200, body: { sent: true, message: messageOf(message) } };
  }

  /** The same message sent again: as it stands, but a waiting one sent now steers, and a refused one is admitted again. */
  #again(thread: Thread, message: Message, who: string, settings: { agent: string; model: string | null }, after: boolean): Reply {
    if (message.state === "pending" && !after) this.#take(thread, message);
    if (message.state === "refused") {
      const refusal = thread.turn ? null : this.admit(who, settings);
      if (refusal) return { status: 200, body: { sent: false, refusal } };
      this.#take(thread, message);
    }
    return { status: 200, body: { sent: true, message: messageOf(message) } };
  }

  /** A turn takes the message: logged as the person's, steering the running turn or starting one. */
  #take(thread: Thread, message: Message): void {
    message.state = "delivered";
    message.refusal = null;
    const starts = !thread.turn;
    if (starts) thread.turn = message.author;
    thread.status = "working";
    this.append(thread.id, [{ type: "message.completed", runId: message.id, ts: Date.now(), messageId: message.id, role: "user", text: message.text }], { by: `user-${message.author}` });
    if (starts) this.append(thread.id, [{ type: "turn.started", ts: Date.now(), turnId: `turn-${thread.id}-${thread.events.length}` }]);
  }

  #unsend(thread: Thread, messageId: string): Reply {
    const message = thread.messages.find((each) => each.id === messageId);
    if (message?.state === "pending" || message?.state === "refused") {
      message.state = "cancelled";
      this.#changed(thread);
    }
    return { status: 204, body: null };
  }

  #stop(thread: Thread): Reply {
    for (const message of thread.messages) if (message.state === "pending") message.state = "cancelled";
    if (thread.turn) this.endTurn(thread.id, "cancelled");
    else this.#changed(thread);
    return { status: 204, body: null };
  }

  #ready(thread: Thread, who: string, body: Record<string, unknown>): Reply {
    if (!this.admit(who, { ...this.#settings(thread), ...(body["settings"] as object | undefined) })) this.readies.push({ threadId: thread.id, settings: body["settings"] ?? null });
    return { status: 202, body: null };
  }

  #answer(who: string, askId: string, body: Record<string, unknown>): Reply {
    const thread = [...this.#threads.values()].find((each) => each.asks.some((ask) => ask.id === askId));
    const ask = thread?.asks.find((each) => each.id === askId);
    if (!thread || !ask || !this.#readable(who, thread.id)) return { status: 404, body: { message: "That request isn't here.", statusCode: 404 } };
    if (ask.answered) return { status: 409, body: { message: "This request was already answered.", statusCode: 409 } };
    const startsTurn = ask.parked && body["decision"] !== "deny";
    const refusal = startsTurn ? this.admit(who, this.#settings(thread)) : null;
    if (refusal) return { status: 200, body: { answered: false, refusal } };
    ask.answered = true;
    if (startsTurn) thread.turn = who;
    this.append(thread.id, [{ type: "approval.resolved", ts: Date.now(), approvalId: ask.id, decision: body["decision"], ...(body["answers"] ? { answers: body["answers"] } : {}) }], {
      by: `user-${who}`,
    });
    this.set(thread.id, { status: thread.turn ? "working" : "idle" });
    return { status: 200, body: { answered: true } };
  }

  #settings(thread: Thread): { agent: string; model: string | null } {
    return { agent: thread.agent, model: null };
  }

  /** The agent asks before it acts, or asks a question: the thread waits on the person. Answers the ask's id. */
  ask(threadId: string, request: { kind: string; toolName?: string; input: unknown; detail: string }): string {
    const thread = this.#threads.get(threadId)!;
    const id = randomUUID();
    thread.asks.push({ id, kind: request.kind, detail: request.detail, answered: false, parked: false });
    thread.status = "needs_answer";
    this.append(threadId, [{ type: "approval.requested", ts: Date.now(), approvalId: id, kind: request.kind, input: request.input, ...(request.toolName && { toolName: request.toolName }) }]);
    return id;
  }

  /**
   * The running turn ends, as its host ends it: an open ask parks and keeps the thread waiting on the person, and the
   * first message waiting for the turn is taken next if its sender may start one, else refused where it waits.
   */
  endTurn(threadId: string, status: "success" | "cancelled" = "success"): void {
    const thread = this.#threads.get(threadId)!;
    thread.turn = null;
    for (const ask of thread.asks) if (!ask.answered) ask.parked = true;
    thread.status = openAsk(thread) ? "needs_answer" : "idle";
    this.append(threadId, [{ type: "turn.completed", ts: Date.now(), turnId: `turn-${threadId}`, status, durationMs: 1000 }]);
    const next = thread.messages.find((message) => message.state === "pending");
    if (!next) return;
    const refusal = this.admit(next.author, this.#settings(thread));
    if (!refusal) return this.#take(thread, next);
    next.state = "refused";
    next.refusal = refusal;
    this.#changed(thread);
  }

  /** The socket's `hosted:watch`: joins the thread's room and answers its head, or `ok: false` for anyone not in it. */
  watch(peer: StandInPeer, threadId: unknown): { ok: boolean; head: number } {
    const who = peer.who();
    const thread = who && typeof threadId === "string" ? this.#readable(who, threadId) : null;
    if (!thread) return { ok: false, head: 0 };
    peer.watched.add(thread.id);
    return { ok: true, head: headOf(thread) };
  }

  unwatch(peer: StandInPeer, threadId: unknown): { ok: boolean } {
    if (typeof threadId === "string") peer.watched.delete(threadId);
    return { ok: true };
  }

  addProject(email: string, project: { name: string; fullName: string }): string {
    const id = randomUUID();
    this.#projects.set(email, [...(this.#projects.get(email) ?? []), { id, ...project }]);
    return id;
  }

  addThread(email: string, seed: StandInThreadSeed): string {
    const id = randomUUID();
    const at = new Date().toISOString();
    const thread: Thread = {
      id,
      owner: email,
      projectId: seed.projectId,
      title: seed.title,
      branch: seed.branch ?? `openorc/${seed.title.toLowerCase().replace(/\W+/g, "-")}`,
      agent: seed.agent ?? "claude",
      status: seed.status ?? "idle",
      seenSeq: 0,
      backgroundCommands: seed.backgroundCommands ?? [],
      stopped: [],
      events: [],
      messages: [],
      asks: [],
      turn: seed.status === "working" ? email : null,
      createdAt: at,
      lastActivityAt: at,
    };
    this.#threads.set(id, thread);
    this.#tellOwner(thread);
    return id;
  }

  /**
   * Stores events in the thread's log, as an agent's host or a person's message does, and sends them to its watchers
   * unless `quiet`, as a frame lost on the way would be. `by` marks a person's own.
   */
  append(threadId: string, events: Record<string, unknown>[], options: { by?: string; quiet?: boolean } = {}): void {
    const thread = this.#threads.get(threadId)!;
    const first = headOf(thread) + 1;
    const stored = events.map((event, index) => ({ seq: first + index, turnId: null, by: options.by ?? null, event: { runId: randomUUID(), ...event } }));
    thread.events.push(...stored);
    if (!options.quiet) this.#tellRoom(thread, "hosted:events", { threadId, events: stored.map((each) => wire(thread, each)), lastAgentSeq: lastAgentSeq(thread) });
    this.#changed(thread);
  }

  set(threadId: string, facts: { status?: "idle" | "working" | "needs_answer"; seenSeq?: number; backgroundCommands?: { id: string; description: string }[] }): void {
    const thread = this.#threads.get(threadId)!;
    Object.assign(thread, facts);
    this.#changed(thread);
  }

  stoppedCommands(threadId: string): string[] {
    return this.#threads.get(threadId)?.stopped ?? [];
  }

  #readable(who: string, id: string): Thread | null {
    const thread = this.#threads.get(id);
    return thread && thread.owner === who ? thread : null;
  }

  #changed(thread: Thread): void {
    thread.lastActivityAt = new Date().toISOString();
    this.#tellOwner(thread);
    this.#tellRoom(thread, "hosted:changed", { threadId: thread.id, status: thread.status, head: headOf(thread), lastAgentSeq: lastAgentSeq(thread) });
  }

  #tellOwner(thread: Thread): void {
    for (const peer of this.peers()) if (peer.who() === thread.owner) peer.send("changed", { organizationId: `personal-${thread.owner}`, topics: ["threads"] });
  }

  #tellRoom(thread: Thread, event: string, body: unknown): void {
    for (const peer of this.peers()) if (peer.watched.has(thread.id) && peer.who() === thread.owner) peer.send(event, body);
  }
}
