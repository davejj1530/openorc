/**
 * The stand-in's hosted threads: threads with their logs, in the spaces of stand-in-spaces.ts, and what the real
 * server tells the sockets of the people who read them. It keeps the real server's rules the app depends on:
 *   a request about a thread is in the space it names (else the person's personal one); a thread of another space is
 *   not there (404). In a team, every member reads every thread; only its starter writes to it, and anyone else is
 *   refused in the real server's words (403). Each reader has a view of their own: seen, pinned, archived, snoozed
 *   `seq` rises by one per stored event; `eventId` is `${threadId}.${seq}`; `turnEnds` are the seqs of `turn.completed`
 *   a page by turn starts after the end of the turn before it, and `limit` still applies to it
 *   a stored batch goes to the sockets watching the thread as `hosted:events`, after it is stored; a socket may watch
 *   a thread of any space its person reads, naming no space
 *   a change to a row (status, head, background commands) goes to its readers' sockets as `changed` with `threads`,
 *   in the thread's space's name
 *   POST /hosted/threads makes a thread on a project of the space; a first message it cannot admit makes none and
 *   answers `{ thread: null, first }`; `ready` with no first message asks the thread to be ready
 *   a message is stored and logged as the person's at once, under the app's id; sending the same id again is the same
 *   message. With no turn running it starts one if the person may (`admit`), else it is refused with nothing stored.
 *   With a turn running it steers it, on that turn's starter, and asks nothing
 *   an ask's `approvalId` is its row id; it stays open when its turn parks, and an answer to a parked ask starts a turn,
 *   so it is admitted like a send; a second answer is a 409
 *   Stop cancels the messages not taken yet and ends the running turn as cancelled
 *   a ready ask from someone who could not start a turn stores nothing
 *   the reader's view (PUT /mine) takes `seenSeq` as given, up to the head, so a lower one marks the thread unread;
 *   a person's own message moves their seen position forward
 *   PATCH renames the thread or changes its settings for everyone; DELETE is the maker's alone
 *   `delivery: "after"` waits, unlogged, in `waiting` with `afterTurn: true`, and is taken when the turn ends
 *   a pending message sent again with delivery "now" steers at once; a refused one sent again is admitted again
 *   DELETE /hosted/threads/:id/messages/:messageId cancels a pending message or dismisses a refused one
 *   a waiting message the host refuses when its turn comes stays in `waiting` as refused
 */
import { randomUUID } from "node:crypto";
import { userOf, type StandInSpaces } from "./stand-in-spaces.js";

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

/** One reader's own view of a thread. */
interface View {
  seenSeq: number;
  pinnedAt: string | null;
  archivedAt: string | null;
  snoozedUntil: string | null;
}

interface Thread {
  id: string;
  space: string;
  owner: string;
  projectId: string | null;
  title: string;
  branch: string;
  agent: string;
  status: string;
  views: Map<string, View>;
  settings: { model: string | null; effort: string | null; mode: string; permissionMode: string };
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
const READ_ONLY: Reply = { status: 403, body: { message: "You can read this thread, but only the people in it can send to it or act on it.", statusCode: 403 } };
const NO_PROJECT: Reply = { status: 404, body: { message: "That project isn't here.", statusCode: 404 } };

const lastAgentSeq = (thread: Thread) => thread.events.findLast((stored) => stored.by === null)?.seq ?? 0;
const headOf = (thread: Thread) => thread.events.at(-1)?.seq ?? 0;
const turnEnds = (thread: Thread) => thread.events.filter((stored) => stored.event["type"] === "turn.completed").map((stored) => stored.seq);
const wire = (thread: Thread, stored: Stored) => ({ seq: stored.seq, turnId: stored.turnId, by: stored.by, event: { ...stored.event, eventId: `${thread.id}.${stored.seq}` } });
const openAsk = (thread: Thread) => thread.asks.find((ask) => !ask.answered) ?? null;
const viewOf = (thread: Thread, who: string): View => thread.views.get(who) ?? { seenSeq: 0, pinnedAt: null, archivedAt: null, snoozedUntil: null };
const UUID = /^[0-9a-f-]{36}$/i;

function messageOf(message: Message) {
  return {
    id: message.id,
    authorId: userOf(message.author),
    text: message.text,
    files: [],
    state: message.state,
    delivery: message.state === "delivered" ? "started" : null,
    refusal: message.refusal,
    afterTurn: message.after,
    createdAt: message.createdAt,
  };
}

/** A stretch of the log: from a turn, or after a seq, at most `limit` events, with the head. */
function pageOf(thread: Thread, query: URLSearchParams) {
  const limit = Number(query.get("limit") ?? 500);
  const ends = turnEnds(thread);
  const fromTurn = query.has("fromTurn") ? Math.min(Number(query.get("fromTurn")), ends.length) : undefined;
  if (query.has("before")) {
    const before = Number(query.get("before"));
    const events = thread.events.filter((stored) => stored.seq < before).slice(-limit);
    return { events: events.map((stored) => wire(thread, stored)), head: headOf(thread) };
  }
  const after = fromTurn === undefined ? Number(query.get("after") ?? 0) : (ends[fromTurn - 1] ?? 0);
  const events = thread.events
    .filter((stored) => stored.seq > after)
    .slice(0, limit)
    .map((stored) => wire(thread, stored));
  return { events, head: headOf(thread), ...(fromTurn !== undefined && { fromTurn }) };
}

export class StandInThreads {
  readonly #threads = new Map<string, Thread>();
  /** Every message body a person posted, in order, as the server took it. */
  readonly sent: { threadId: string; body: Record<string, unknown> }[] = [];
  /** Every ready ask the stand-in stored, in order. */
  readonly readies: { threadId: string; settings: unknown }[] = [];
  /** Every POST /hosted/threads body, in order, with the space it named. */
  readonly started: { space: string; body: Record<string, unknown> }[] = [];

  constructor(
    private readonly peers: () => Iterable<StandInPeer>,
    private readonly admit: Admit,
    private readonly spaces: StandInSpaces,
    private readonly person: (email: string) => { name: string; image: string | null },
  ) {}

  /** The person's spaces, and the routes under /projects and /hosted, for `who` in the space they name; null for any other path. */
  route(request: { method: string; path: string; query: URLSearchParams; space: string | null }, who: string, body: Record<string, unknown> = {}): Reply | null {
    const { method, path } = request;
    if (method === "GET" && path === "/api/auth/organization/list") return { status: 200, body: this.spaces.spacesOf(who) };
    if (!/^\/(projects|hosted)\b/.test(path)) return null;
    const space = this.spaces.resolve(who, request.space);
    if (typeof space !== "string") return space;
    if (method === "GET" && path === "/projects") return { status: 200, body: this.spaces.listed(space, who) };
    const asked = /^\/hosted\/asks\/([^/]+)\/answer$/.exec(path);
    if (asked && method === "POST") return this.#answer(who, space, decodeURIComponent(asked[1]!), body);
    if (method === "POST" && path === "/hosted/threads") return this.#create(who, space, body);
    const write = /^\/hosted\/threads\/([^/]+)\/(messages|stop|ready|mine)(?:\/([^/]+))?$/.exec(path);
    if (write) return this.#write(method, write, { who, space }, body);
    return this.#read(method, path, request.query, { who, space }, body);
  }

  /** The list, one thread, its log, its title and settings, its removal, and a background command's stop. */
  #read(method: string, path: string, query: URLSearchParams, as: { who: string; space: string }, body: Record<string, unknown>): Reply | null {
    if (method === "GET" && path === "/hosted/threads") {
      const read = [...this.#threads.values()].filter((thread) => this.#reads(as.who, thread) && thread.space === as.space).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
      return { status: 200, body: { threads: read.map((thread) => this.#rowOf(thread, as.who)) } };
    }
    const match = /^\/hosted\/threads\/([^/]+)(\/events|\/commands\/([^/]+)\/stop)?$/.exec(path);
    if (!match) return null;
    const thread = this.#readable(as, decodeURIComponent(match[1]!));
    if (!thread) return missing();
    if (method === "GET" && match[2] === "/events") return { status: 200, body: pageOf(thread, query) };
    if (!match[2]) return this.#one(method, thread, as.who, body);
    if (method !== "POST" || !match[3]) return null;
    if (thread.owner !== as.who) return READ_ONLY;
    thread.stopped.push(decodeURIComponent(match[3]));
    return { status: 204, body: null };
  }

  /** One thread by its own path: read by any reader; renamed or deleted by its starter. */
  #one(method: string, thread: Thread, who: string, body: Record<string, unknown>): Reply | null {
    if (method === "GET") return { status: 200, body: { ...this.#rowOf(thread, who), turnEnds: turnEnds(thread) } };
    if (thread.owner !== who && (method === "PATCH" || method === "DELETE")) return READ_ONLY;
    if (method === "PATCH") return this.#rename(thread, who, body);
    if (method === "DELETE") return this.#delete(thread);
    return null;
  }

  /** A thread's messages, its Stop, its ready ask and the reader's view: `[path, threadId, verb, messageId?]`. */
  #write(method: string, [, threadId, verb, messageId]: RegExpExecArray, as: { who: string; space: string }, body: Record<string, unknown>): Reply | null {
    const thread = this.#readable(as, decodeURIComponent(threadId!));
    if (!thread) return missing();
    const key = `${method} ${verb}${messageId ? "/:id" : ""}`;
    if (key === "PUT mine") return this.#view(thread, as.who, body);
    if (thread.owner !== as.who) return READ_ONLY;
    if (key === "POST messages") return this.#send(thread, as.who, body);
    if (key === "DELETE messages/:id") return this.#unsend(thread, decodeURIComponent(messageId!));
    if (key === "POST stop") return this.#stop(thread);
    if (key === "POST ready") return this.#ready(thread, as.who, body);
    return null;
  }

  /** A new thread on a project of the space, with its first message when one comes and can start a turn. */
  #create(who: string, space: string, body: Record<string, unknown>): Reply {
    this.started.push({ space, body });
    const project = this.spaces.project(space, typeof body["projectId"] === "string" ? body["projectId"] : null);
    if (!project || !this.spaces.canRead(space, project.id, who)) return NO_PROJECT;
    const settings = { model: null, effort: null, mode: "act", permissionMode: "trusted", ...(body["settings"] as Record<string, unknown>) } as Thread["settings"] & { agent?: string };
    const first = body["first"] as Record<string, unknown> | undefined;
    if (first) {
      const refusal = this.admit(who, { agent: settings.agent ?? "claude", model: settings.model, ...(first["settings"] as object | undefined) });
      if (refusal) return { status: 201, body: { thread: null, first: { sent: false, refusal } } };
    }
    const { agent, ...rest } = settings;
    const id = this.addThread(who, { projectId: project.id, title: typeof body["title"] === "string" ? body["title"] : "", ...(agent && { agent: agent as StandInThreadSeed["agent"] }) });
    const thread = this.#threads.get(id)!;
    thread.settings = rest;
    if (!first && body["ready"] === true) this.readies.push({ threadId: id, settings: null });
    const sent = first ? this.#send(thread, who, first) : null;
    return { status: 201, body: { thread: this.#rowOf(thread, who), first: (sent?.body as object | undefined) ?? null } };
  }

  /** The reader's own view: each part given is set, the rest left as they are. Answers the row. */
  #view(thread: Thread, who: string, body: Record<string, unknown>): Reply {
    const now = new Date().toISOString();
    const view = { ...viewOf(thread, who) };
    if (typeof body["seenSeq"] === "number") view.seenSeq = Math.min(body["seenSeq"], headOf(thread));
    if (typeof body["pinned"] === "boolean") view.pinnedAt = body["pinned"] ? now : null;
    if (typeof body["archived"] === "boolean") view.archivedAt = body["archived"] ? now : null;
    if (body["snoozedUntil"] !== undefined) view.snoozedUntil = (body["snoozedUntil"] as string | null) ?? null;
    thread.views.set(who, view);
    this.#tellReaders(thread, [who]);
    return { status: 200, body: this.#rowOf(thread, who) };
  }

  /** The thread's title and what its next turns run with, for everyone in it. Answers the row. */
  #rename(thread: Thread, who: string, body: Record<string, unknown>): Reply {
    const settings = (body["settings"] ?? {}) as Partial<Thread["settings"]> & { agent?: string };
    if (typeof body["title"] === "string") thread.title = body["title"].trim();
    const { agent, ...rest } = settings;
    if (agent) thread.agent = agent;
    thread.settings = { ...thread.settings, ...rest };
    this.#changed(thread);
    return { status: 200, body: this.#rowOf(thread, who) };
  }

  #delete(thread: Thread): Reply {
    this.#threads.delete(thread.id);
    this.#tellReaders(thread);
    return { status: 204, body: null };
  }

  #send(thread: Thread, who: string, body: Record<string, unknown>): Reply {
    this.sent.push({ threadId: thread.id, body });
    const id = String(body["id"] ?? "");
    if (!UUID.test(id)) return { status: 400, body: { message: "Invalid input: expected uuid", statusCode: 400 } };
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
    this.append(thread.id, [{ type: "message.completed", runId: message.id, ts: Date.now(), messageId: message.id, role: "user", text: message.text }], { by: userOf(message.author) });
    // A person's own message is read by them.
    const view = viewOf(thread, message.author);
    thread.views.set(message.author, { ...view, seenSeq: Math.max(view.seenSeq, headOf(thread)) });
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

  /** Access is checked before any more content can reach a former reader. */
  accessChanged(space: string): void {
    for (const thread of this.#threads.values()) {
      if (thread.space !== space) continue;
      for (const peer of this.peers()) if (!this.#reads(peer.who() ?? "", thread)) peer.watched.delete(thread.id);
      for (const message of thread.messages) if (message.state === "pending" && !this.#reads(message.author, thread)) message.state = "cancelled";
      if (thread.turn && !this.#reads(thread.turn, thread)) {
        this.#stop(thread);
        const turnId = String(thread.events.findLast((stored) => stored.event["type"] === "turn.completed")!.event["turnId"]);
        this.append(thread.id, [{ type: "error", runId: turnId, ts: Date.now(), fatal: true, message: "This turn stopped because its sender no longer has access to this project." }], { turnId });
      } else this.#changed(thread);
    }
  }

  #ready(thread: Thread, who: string, body: Record<string, unknown>): Reply {
    if (!this.admit(who, { ...this.#settings(thread), ...(body["settings"] as object | undefined) })) this.readies.push({ threadId: thread.id, settings: body["settings"] ?? null });
    return { status: 202, body: null };
  }

  #answer(who: string, space: string, askId: string, body: Record<string, unknown>): Reply {
    const thread = [...this.#threads.values()].find((each) => each.asks.some((ask) => ask.id === askId));
    const ask = thread?.asks.find((each) => each.id === askId);
    if (!thread || !ask || !this.#readable({ who, space }, thread.id)) return { status: 404, body: { message: "That request isn't here.", statusCode: 404 } };
    if (thread.owner !== who) return READ_ONLY;
    if (ask.answered) return { status: 409, body: { message: "This request was already answered.", statusCode: 409 } };
    const startsTurn = ask.parked && body["decision"] !== "deny";
    const refusal = startsTurn ? this.admit(who, this.#settings(thread)) : null;
    if (refusal) return { status: 200, body: { answered: false, refusal } };
    ask.answered = true;
    if (startsTurn) thread.turn = who;
    this.append(thread.id, [{ type: "approval.resolved", ts: Date.now(), approvalId: ask.id, decision: body["decision"], ...(body["answers"] ? { answers: body["answers"] } : {}) }], {
      by: userOf(who),
    });
    this.set(thread.id, { status: thread.turn ? "working" : "idle" });
    return { status: 200, body: { answered: true } };
  }

  #settings(thread: Thread): { agent: string; model: string | null } {
    return { agent: thread.agent, model: thread.settings.model };
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
    for (const message of thread.messages) if (message.state === "pending" && !this.#reads(message.author, thread)) message.state = "cancelled";
    const next = thread.messages.find((message) => message.state === "pending");
    if (!next) return;
    const refusal = this.admit(next.author, this.#settings(thread));
    if (!refusal) return this.#take(thread, next);
    next.state = "refused";
    next.refusal = refusal;
    this.#changed(thread);
  }

  /** The socket's `hosted:watch`: joins the thread's room and answers its head, or `ok: false` for anyone who does not read it. */
  watch(peer: StandInPeer, threadId: unknown): { ok: boolean; head: number } {
    const who = peer.who();
    const thread = typeof threadId === "string" ? this.#threads.get(threadId) : undefined;
    if (!who || !thread || !this.#reads(who, thread)) return { ok: false, head: 0 };
    peer.watched.add(thread.id);
    return { ok: true, head: headOf(thread) };
  }

  unwatch(peer: StandInPeer, threadId: unknown): { ok: boolean } {
    if (typeof threadId === "string") peer.watched.delete(threadId);
    return { ok: true };
  }

  /** A thread the person started, in the space of its project. Answers its id. */
  addThread(email: string, seed: StandInThreadSeed): string {
    const id = randomUUID();
    const at = new Date().toISOString();
    const thread: Thread = {
      id,
      space: this.spaces.spaceOfProject(seed.projectId, email),
      owner: email,
      projectId: seed.projectId,
      title: seed.title,
      branch: seed.branch ?? `openorc/${seed.title.toLowerCase().replace(/\W+/g, "-")}`,
      agent: seed.agent ?? "claude",
      status: seed.status ?? "idle",
      views: new Map(),
      settings: { model: null, effort: null, mode: "act", permissionMode: "trusted" },
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
    this.#tellReaders(thread);
    return id;
  }

  /**
   * Stores events in the thread's log, as an agent's host or a person's message does, and sends them to its watchers
   * unless `quiet`, as a frame lost on the way would be. `by` marks a person's own.
   */
  append(threadId: string, events: Record<string, unknown>[], options: { by?: string; quiet?: boolean; turnId?: string } = {}): void {
    const thread = this.#threads.get(threadId)!;
    const first = headOf(thread) + 1;
    const stored = events.map((event, index) => ({ seq: first + index, turnId: options.turnId ?? null, by: options.by ?? null, event: { runId: randomUUID(), ...event } }));
    thread.events.push(...stored);
    if (!options.quiet) this.#tellRoom(thread, "hosted:events", { threadId, events: stored.map((each) => wire(thread, each)), lastAgentSeq: lastAgentSeq(thread) });
    this.#changed(thread);
  }

  /** Changes what a row says; `seenSeq` is its starter's own. */
  set(threadId: string, facts: { status?: "idle" | "working" | "needs_answer"; seenSeq?: number; backgroundCommands?: { id: string; description: string }[] }): void {
    const thread = this.#threads.get(threadId)!;
    const { seenSeq, ...rest } = facts;
    Object.assign(thread, rest);
    if (seenSeq !== undefined) thread.views.set(thread.owner, { ...viewOf(thread, thread.owner), seenSeq });
    this.#changed(thread);
  }

  stoppedCommands(threadId: string): string[] {
    return this.#threads.get(threadId)?.stopped ?? [];
  }

  /** A thread as a reader's list shows it, with every field the real server answers. */
  #rowOf(thread: Thread, who: string) {
    const ask = openAsk(thread);
    return {
      id: thread.id,
      projectId: thread.projectId,
      parentId: null,
      title: thread.title,
      baseBranch: "main",
      branch: thread.branch,
      settings: { agent: thread.agent, ...thread.settings },
      status: thread.status,
      head: headOf(thread),
      turns: turnEnds(thread).length,
      ...viewOf(thread, who),
      lastAgentSeq: lastAgentSeq(thread),
      turn: thread.turn ? { id: `turn-${thread.id}`, startedBy: userOf(thread.turn), startedAt: thread.lastActivityAt, state: "running" } : null,
      backgroundCommands: thread.backgroundCommands,
      waiting: thread.messages.filter((message) => message.state === "pending" || message.state === "refused").map(messageOf),
      ask: ask ? { id: ask.id, kind: ask.kind, detail: ask.detail } : null,
      work: { uncommitted: null, unpushed: null, published: false },
      pullRequest: null,
      actions: [],
      createdBy: userOf(thread.owner),
      startedBy: { id: userOf(thread.owner), ...this.person(thread.owner) },
      createdAt: thread.createdAt,
      lastActivityAt: thread.lastActivityAt,
    };
  }

  #reads(who: string, thread: Thread): boolean {
    return thread.projectId ? this.spaces.canRead(thread.space, thread.projectId, who) : this.spaces.readers(thread.space).includes(who);
  }

  /** A thread of the space the request is in, which the person reads; null for any other. */
  #readable(as: { who: string; space: string }, id: string): Thread | null {
    const thread = this.#threads.get(id);
    return thread && thread.space === as.space && this.#reads(as.who, thread) ? thread : null;
  }

  #changed(thread: Thread): void {
    thread.lastActivityAt = new Date().toISOString();
    this.#tellReaders(thread);
    this.#tellRoom(thread, "hosted:changed", { threadId: thread.id, status: thread.status, head: headOf(thread), lastAgentSeq: lastAgentSeq(thread) });
  }

  /** `changed` with `threads`, in the thread's space's name, to its readers' sockets, or to some of them. */
  #tellReaders(thread: Thread, only = this.spaces.readers(thread.space)): void {
    for (const peer of this.peers()) if (only.includes(peer.who() ?? "")) peer.send("changed", { organizationId: thread.space, topics: ["threads"] });
  }

  #tellRoom(thread: Thread, event: string, body: unknown): void {
    for (const peer of this.peers()) if (peer.watched.has(thread.id) && this.#reads(peer.who() ?? "", thread)) peer.send(event, body);
  }
}
