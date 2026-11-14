/**
 * The stand-in's hosted threads: threads with their logs, in the spaces of stand-in-spaces.ts, and what the real
 * server tells the sockets of the people who read them. It keeps the real server's rules the app depends on:
 *   a request about a thread is in the space it names (else the person's personal one); a thread of another space is
 *   not there (404). In a team, every member reads every thread; only its starter writes to it, and anyone else is
 *   refused in the real server's words (403), until `collaboration.sharedWrites` opens writing to its project's readers. Each reader has a view of their own: seen, pinned, archived, snoozed
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
import { titleFromPrompt } from "@openorc/protocol";
import { userOf, type StandInSpaces } from "./stand-in-spaces.js";
import { attachedPath, StandInThreadFiles } from "./stand-in-thread-files.js";
import { StandInCollaboration } from "./stand-in-collaboration.js";
import type { UploadedFile } from "../wire-files.js";

export interface StandInPeer {
  /** The address the socket's token is for, or null once its session ended. */
  who(): string | null;
  watched: Set<string>;
  send(event: string, body: unknown): void;
}

export interface StandInThreadSeed {
  projectId: string | null;
  title: string;
  createdAt?: string;
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
  files: UploadedFile[];
  /** Paused by someone's Stop or a failed handoff: no turn takes it until its author starts it. */
  paused?: boolean;
}

interface Ask {
  id: string;
  kind: string;
  detail: string;
  answered: boolean;
  /** Its turn parked: answering it starts a turn. */
  parked: boolean;
  /** The turn that asked it. */
  turnId: string;
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
  /** The running turn, or the last one; each turn's sender by address; when the running one started. */
  turnId: string | null;
  turns: Map<string, string>;
  turnStartedAt: string | null;
  stopping: boolean;
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
/** The agent's own id for a turn. Its host's turn events carry it; the server names the turn by its row's id, on each stored event. */
const agentTurn = (turnId: string) => `${turnId}-agent`;
const wire = (thread: Thread, stored: Stored) => ({ seq: stored.seq, turnId: stored.turnId, by: stored.by, event: { ...stored.event, eventId: `${thread.id}.${stored.seq}` } });
const openAsk = (thread: Thread) => thread.asks.find((ask) => !ask.answered) ?? null;
const viewOf = (thread: Thread, who: string): View => thread.views.get(who) ?? { seenSeq: 0, pinnedAt: null, archivedAt: null, snoozedUntil: null };
const UUID = /^[0-9a-f-]{36}$/i;

function messageOf(message: Message) {
  return {
    id: message.id,
    authorId: userOf(message.author),
    text: message.text,
    files: message.files,
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
  /** Every Retry save asked, by thread. */
  readonly saveRetries: string[] = [];
  /** Each explicit Start's answer, by its request id. */
  readonly #starts = new Map<string, Reply>();
  /** Every ready ask the stand-in stored, in order. */
  readonly readies: { threadId: string; settings: unknown }[] = [];
  /** Every POST /hosted/threads body, in order, with the space it named. */
  readonly started: { space: string; body: Record<string, unknown> }[] = [];
  /** Capabilities, files on messages and the files unit's rules. */
  readonly files = new StandInThreadFiles();
  /** Who writes, sends and waits in a thread, and the server's capability for it. */
  readonly collaboration: StandInCollaboration;

  constructor(
    private readonly peers: () => Iterable<StandInPeer>,
    private readonly admit: Admit,
    private readonly spaces: StandInSpaces,
    person: (email: string) => { name: string; image: string | null },
  ) {
    this.collaboration = new StandInCollaboration(person, (threadId) => {
      const thread = this.#threads.get(threadId);
      return thread ? this.spaces.readers(thread.space).filter((who) => this.#reads(who, thread)) : [];
    });
  }

  /** The person's spaces, and the routes under /projects and /hosted, for `who` in the space they name; null for any other path. */
  route(request: { method: string; path: string; query: URLSearchParams; space: string | null }, who: string, body: Record<string, unknown> = {}): Reply | null {
    const { method, path } = request;
    if (method === "GET" && path === "/api/auth/organization/list") return { status: 200, body: this.spaces.spacesOf(who) };
    if (!/^\/(projects|hosted)\b/.test(path)) return null;
    const space = this.spaces.resolve(who, request.space);
    if (typeof space !== "string") return space;
    if (method === "GET" && path === "/projects") return { status: 200, body: this.spaces.listed(space, who) };
    if (method === "GET" && path === "/hosted/capabilities") return this.files.capabilityReply();
    const asked = /^\/hosted\/asks\/([^/]+)\/answer$/.exec(path);
    if (asked && method === "POST") return this.#answer(who, space, decodeURIComponent(asked[1]!), body);
    if (method === "POST" && path === "/hosted/threads") return this.#create(who, space, body);
    const together = this.#together(request, { who, space }, body);
    if (together) return together;
    const write = /^\/hosted\/threads\/([^/]+)\/(messages|stop|ready|mine)(?:\/([^/]+))?$/.exec(path);
    if (write) return this.#write(method, write, { who, space }, body);
    return this.#read(method, path, request.query, { who, space }, body);
  }

  /** A thread's collaboration reads, an author's Start of a paused message, and Retry save. */
  #together(request: { method: string; path: string; query: URLSearchParams }, as: { who: string; space: string }, body: Record<string, unknown>): Reply | null {
    const start = /^\/hosted\/threads\/([^/]+)\/messages\/([^/]+)\/start$/.exec(request.path);
    const retry = /^\/hosted\/threads\/([^/]+)\/retry-save$/.exec(request.path);
    const write = start ?? retry;
    if (write && request.method === "POST") {
      const thread = this.#readable(as, decodeURIComponent(write[1]!));
      if (!thread) return missing();
      if (!this.collaboration.sharedWrites) return READ_ONLY;
      if (start) return this.#startPaused(thread, as.who, decodeURIComponent(start[2]!), body);
      this.saveRetries.push(thread.id);
      return { status: 202, body: null };
    }
    const read = /^\/hosted\/threads\/([^/]+)\/(collaboration|turn-senders|people)$/.exec(request.path);
    if (!read) return null;
    const thread = this.#readable(as, decodeURIComponent(read[1]!));
    return thread ? this.collaboration.route(request.method, read[2]!, request.query, thread, as.who) : missing();
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
    if (thread.owner !== as.who && !this.collaboration.sharedWrites) return READ_ONLY;
    if (key === "POST messages") return this.#joinRefusal(thread, as.who, body) ?? this.#send(thread, as.who, body);
    if (key === "POST stop" && this.#joinsOnly(thread, as.who)) return READ_ONLY;
    if (key === "DELETE messages/:id") return this.#unsend(thread, decodeURIComponent(messageId!), as.who);
    if (key === "POST stop") return typeof body["turnId"] === "string" && this.collaboration.sharedWrites ? this.#stopShared(thread, as.who, body["turnId"]) : this.#stop(thread);
    if (key === "POST ready") return this.#ready(thread, as.who, body);
    return null;
  }

  /** A new thread on a project of the space, with its first message when one comes and can start a turn. */
  #create(who: string, space: string, body: Record<string, unknown>): Reply {
    this.started.push({ space, body });
    const replayed = this.files.replayStart(who, space, body);
    if (replayed) return replayed;
    const reply = this.#createNew(who, space, body);
    this.files.rememberStart(who, space, body, reply);
    return reply;
  }

  #createNew(who: string, space: string, body: Record<string, unknown>): Reply {
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
    if (body["expectedTitle"] !== undefined && body["expectedTitle"] !== this.#title(thread)) return { status: 200, body: this.#rowOf(thread, who) };
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
    const place = this.collaboration.sharedWrites ? this.#placeShared(thread, who, body, settings, after) : this.#placeOwn(thread, who, settings, after);
    if (place.refusal) return { status: 200, body: { sent: false, refusal: place.refusal } };
    const files = this.files.claim({ who, space: thread.space, projectId: thread.projectId ?? "", messageId: id, ids: body["fileIds"], thread: thread.messages });
    if (!Array.isArray(files)) return files;
    const message: Message = {
      id,
      author: who,
      text: String(body["text"] ?? ""),
      state: "pending",
      refusal: null,
      after: place.queue,
      createdAt: new Date().toISOString(),
      files,
      paused: place.paused,
    };
    thread.messages.push(message);
    if (!thread.title.trim() && thread.messages.length === 1) thread.title = titleFromPrompt(message.text);
    if ("settle" in place) this.#settle(thread, message, settings);
    else if (!message.after) this.#take(thread, message);
    else this.#changed(thread);
    return { status: 200, body: { sent: true, message: messageOf(message) } };
  }

  /** A waiting message taken on an idle thread: its author's own turn if they may start one, else refused where it waits. */
  #settle(thread: Thread, message: Message, settings: { agent: string; model: string | null }): void {
    const refusal = this.admit(message.author, settings);
    if (!refusal) return this.#take(thread, message);
    message.state = "refused";
    message.refusal = refusal;
    this.#changed(thread);
  }

  /** While only joining is open, a teammate who is not the thread's creator. */
  #joinsOnly(thread: Thread, who: string): boolean {
    return this.collaboration.sharedWrites && this.collaboration.joinOnly && thread.owner !== who;
  }

  /** A teammate's write that would start a turn while only joining is open: refused with the block, nothing stored. */
  #joinRefusal(thread: Thread, who: string, body: Record<string, unknown>): Reply | null {
    if (!this.#joinsOnly(thread, who) || thread.messages.some((message) => message.id === body["id"])) return null;
    const joins = body["delivery"] !== "after" && (thread.turn || typeof body["expectedTurnId"] === "string");
    if (joins) return null;
    const block = this.collaboration.joinBlock(thread);
    return { status: 409, body: { code: block.code, message: block.message, block, statusCode: 409 } };
  }

  /** Where a message goes under the starter-only rule: into the running turn, after it, or a new turn if admitted. */
  #placeOwn(thread: Thread, who: string, settings: { agent: string; model: string | null }, after: boolean) {
    const refusal = thread.turn ? null : this.admit(who, settings);
    return { refusal: after && thread.turn ? null : refusal, queue: Boolean(thread.turn) && after, paused: false };
  }

  /**
   * Where a message goes once shared writing is open: Send now joins the turn it names, on that turn's sender, asking
   * nothing of its author; one naming a turn that is gone or another waits as its author's own; Queue and a new turn
   * need the author's own admission; a turn stopping takes nothing, so the message waits paused.
   */
  #placeShared(thread: Thread, who: string, body: Record<string, unknown>, settings: { agent: string; model: string | null }, after: boolean) {
    const expected = typeof body["expectedTurnId"] === "string" ? body["expectedTurnId"] : null;
    if (thread.stopping) return { refusal: null, queue: true, paused: true };
    if (thread.turn && !after && (!expected || expected === thread.turnId)) return { refusal: null, queue: false, paused: false };
    // Its turn ended or changed before it arrived: it waits as the author's own. While only joining is open it waits
    // paused, since nothing a teammate sends may start a turn; else it is admitted as theirs when it is taken.
    if (expected && !after && this.#joinsOnly(thread, who)) return { refusal: null, queue: true, paused: true };
    if (thread.turn && !after) return { refusal: null, queue: true, paused: false };
    if (expected && !after) return { refusal: null, queue: true, paused: false, settle: true };
    return { refusal: this.admit(who, settings), queue: Boolean(thread.turn), paused: false };
  }

  /**
   * An author starts their own paused message as their own turn, once the thread is idle and they may start one. The
   * same request id again answers what it answered, and never starts a second turn.
   */
  #startPaused(thread: Thread, who: string, messageId: string, body: Record<string, unknown>): Reply {
    const requestId = typeof body["requestId"] === "string" ? body["requestId"] : null;
    const replay = requestId ? this.#starts.get(requestId) : undefined;
    if (replay) return replay;
    const message = thread.messages.find((each) => each.id === messageId);
    if (!message || message.state !== "pending") return { status: 404, body: { message: "That message isn't here.", statusCode: 404 } };
    if (message.author !== who) return { status: 403, body: { code: "message_author_only", message: "Only the sender can change this queued message.", statusCode: 403 } };
    if (thread.turn) return { status: 409, body: { code: "thread_busy", message: "A turn is running. Wait for it to finish.", statusCode: 409 } };
    if (this.#joinsOnly(thread, who)) {
      const block = this.collaboration.joinBlock(thread);
      return { status: 409, body: { code: block.code, message: block.message, block, statusCode: 409 } };
    }
    const refusal = this.admit(who, this.#settings(thread));
    const reply: Reply = refusal ? { status: 200, body: { sent: false, refusal } } : { status: 200, body: { sent: true, message: messageOf(message) } };
    if (!refusal) {
      message.paused = false;
      this.#take(thread, message);
      (reply.body as { message: unknown }).message = messageOf(message);
    }
    if (requestId) this.#starts.set(requestId, reply);
    return reply;
  }

  /** Stop of the turn the window saw: the stopper's own waiting messages go, everyone else's wait paused for their authors. */
  #stopShared(thread: Thread, who: string, turnId: string): Reply {
    if (thread.turnId !== turnId || !thread.turn) return { status: 409, body: { code: "turn_changed", message: "That turn ended. Check the thread before stopping again.", statusCode: 409 } };
    for (const message of thread.messages) {
      if (message.state !== "pending") continue;
      if (message.author === who) message.state = "cancelled";
      else message.paused = true;
    }
    const sender = this.collaboration.personOf(thread.turn)?.name.split(" ")[0] ?? "the previous sender";
    const stopper = this.collaboration.personOf(who)?.name.split(" ")[0] ?? "Someone";
    this.append(thread.id, [{ type: "message.completed", ts: Date.now(), messageId: randomUUID(), role: "system", text: `${stopper} stopped ${sender}'s turn.` }], { by: userOf(who) });
    this.endTurn(thread.id, "cancelled");
    return { status: 204, body: null };
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
    if (starts) this.#startTurn(thread, message.author);
    thread.status = "working";
    const attachments = message.files.map(attachedPath);
    this.append(thread.id, [{ type: "message.completed", runId: message.id, ts: Date.now(), messageId: message.id, role: "user", text: message.text, ...(attachments.length && { attachments }) }], {
      by: userOf(message.author),
    });
    // A person's own message is read by them.
    const view = viewOf(thread, message.author);
    thread.views.set(message.author, { ...view, seenSeq: Math.max(view.seenSeq, headOf(thread)) });
    if (starts) this.append(thread.id, [{ type: "turn.started", ts: Date.now(), turnId: agentTurn(thread.turnId!) }]);
  }

  #unsend(thread: Thread, messageId: string, who: string): Reply {
    const message = thread.messages.find((each) => each.id === messageId);
    if (message && this.collaboration.sharedWrites && message.author !== who)
      return { status: 403, body: { code: "message_author_only", message: "Only the sender can change this queued message.", statusCode: 403 } };
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
        const turnId = String(thread.events.findLast((stored) => stored.event["type"] === "turn.completed")!.turnId);
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
    if (startsTurn) this.#startTurn(thread, who);
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
    thread.asks.push({ id, kind: request.kind, detail: request.detail, answered: false, parked: false, turnId: thread.turnId ?? `turn-${thread.id}` });
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
    thread.stopping = false;
    thread.turnStartedAt = null;
    for (const ask of thread.asks) if (!ask.answered) ask.parked = true;
    thread.status = openAsk(thread) ? "needs_answer" : "idle";
    this.append(threadId, [{ type: "turn.completed", ts: Date.now(), turnId: agentTurn(thread.turnId ?? `turn-${threadId}`), status, durationMs: 1000 }]);
    thread.turnId = null;
    for (const message of thread.messages) if (message.state === "pending" && !this.#reads(message.author, thread)) message.state = "cancelled";
    const next = thread.messages.find((message) => message.state === "pending" && !message.paused);
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
    const at = seed.createdAt ?? new Date().toISOString();
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
      turn: null,
      turnId: null,
      turns: new Map(),
      turnStartedAt: null,
      stopping: false,
      createdAt: at,
      lastActivityAt: at,
    };
    if (seed.status === "working") this.#startTurn(thread, email);
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
    const stored = events.map((event, index) => ({ seq: first + index, turnId: options.turnId ?? thread.turnId, by: options.by ?? null, event: { runId: randomUUID(), ...event } }));
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
      title: this.#title(thread),
      baseBranch: "main",
      branch: thread.branch,
      settings: { agent: thread.agent, ...thread.settings },
      status: thread.status,
      head: headOf(thread),
      turns: turnEnds(thread).length,
      ...viewOf(thread, who),
      lastAgentSeq: lastAgentSeq(thread),
      turn:
        thread.turn && thread.turnId
          ? { id: thread.turnId, startedBy: userOf(thread.turn), startedAt: thread.turnStartedAt ?? thread.lastActivityAt, state: thread.stopping ? "stopping" : "running" }
          : null,
      backgroundCommands: thread.backgroundCommands,
      waiting: thread.messages.filter((message) => message.state === "pending" || message.state === "refused").map(messageOf),
      ask: ask ? { id: ask.id, kind: ask.kind, detail: ask.detail } : null,
      work: { uncommitted: null, unpushed: null, published: false },
      pullRequest: null,
      actions: [],
      createdBy: userOf(thread.owner),
      startedBy: this.collaboration.personOf(thread.owner),
      ...(this.collaboration.served && { collaboration: this.collaboration.projection(thread, who) }),
      createdAt: thread.createdAt,
      lastActivityAt: thread.lastActivityAt,
    };
  }

  /** A new turn, sent by `who`: its own id, which the log's events of it carry. */
  #startTurn(thread: Thread, who: string): void {
    thread.turn = who;
    thread.turnId = `turn-${thread.id.slice(0, 8)}-${thread.turns.size + 1}`;
    thread.turns.set(thread.turnId, who);
    thread.turnStartedAt = new Date().toISOString();
  }

  #title(thread: Thread): string {
    if (thread.title.trim()) return thread.title;
    const first = thread.messages[0]?.text;
    const event = thread.events.find(({ event }) => event["type"] === "message.completed" && event["role"] === "user")?.event;
    return titleFromPrompt(first ?? (typeof event?.["text"] === "string" ? event["text"] : ""));
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
