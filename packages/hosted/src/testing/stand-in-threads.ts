/**
 * The stand-in's hosted threads: projects by person, threads with their logs, and what the real server tells the
 * sockets of people in a thread. It keeps the real server's rules the app depends on:
 *   a thread is read only by the person who started it (the real server makes no other readers yet)
 *   `seq` rises by one per stored event; `eventId` is `${threadId}.${seq}`; `turnEnds` are the seqs of `turn.completed`
 *   a page by turn starts after the end of the turn before it, and `limit` still applies to it
 *   a stored batch goes to the sockets watching the thread as `hosted:events`, after it is stored
 *   a change to a row (status, head, background commands) goes to its reader's sockets as `changed` with `threads`
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
    turn: null,
    backgroundCommands: thread.backgroundCommands,
    waiting: [],
    ask: null,
    work: { uncommitted: null, unpushed: null, published: false },
    pullRequest: null,
    actions: [],
    createdBy: `user-${thread.owner}`,
    createdAt: thread.createdAt,
    lastActivityAt: thread.lastActivityAt,
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

  constructor(private readonly peers: () => Iterable<StandInPeer>) {}

  /** The routes under /projects and /hosted, for the person `who`; null for a path that is not one of them. */
  route(method: string, path: string, query: URLSearchParams, who: string): Reply | null {
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
