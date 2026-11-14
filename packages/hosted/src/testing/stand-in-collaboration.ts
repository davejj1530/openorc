/**
 * The stand-in's reads of working together in a thread, with the real server's rules the app depends on:
 *   every row carries the reader's collaboration, and `GET /hosted/threads/:id/collaboration` answers the same object
 *   creator, live sender, ask sender, queue author and reader stay apart; the live turn's and the ask's sender are the
 *   person whose turn it is, and a waiting ask is answerable only by them, while its turn runs
 *   shared writing is closed, as on today's server: `canWrite: false`, `send: "blocked"`, no notes and no Stop, for
 *   everyone. `sharedWrites` answers as the server will once it opens: anyone who reads the project writes, sends now
 *   into a running turn or after a stopping one, and stops
 *   `GET .../turn-senders?turnIds=` names the sender of each of the thread's turns asked about, null for a former
 *   member, and leaves out ids of any other thread; at most a hundred
 *   `GET .../people?q=` lists the members who read the thread's project, by name, with their address
 *   `served: false` is a server that predates all of it: no field on rows and 404 for the three reads
 */
import { userOf } from "./stand-in-spaces.js";

type Reply = { status: number; body: unknown };
type Person = { id: string; name: string; image: string | null };

/** What the projection reads of a stand-in thread. */
export interface CollaborationThread {
  id: string;
  /** Who started the running turn, by address; null between turns. */
  turn: string | null;
  turnId: string | null;
  /** Each turn's sender, by address; a sender removed since is left out. */
  turns: Map<string, string>;
  turnStartedAt: string | null;
  stopping: boolean;
  asks: { id: string; turnId: string; answered: boolean; parked: boolean }[];
  messages: { id: string; author: string; state: string }[];
}

/** live: the ask's own sender while its turn runs. start: a parked ask anyone who writes may answer. */
const answerOf = (ownsLive: boolean, startable: boolean) => {
  if (ownsLive) return "live";
  return startable ? "start" : "blocked";
};

export class StandInCollaboration {
  /** False: a server that predates working together. */
  served = true;
  /** Shared writing open, as the server will answer once its launch isolation is proved. */
  sharedWrites = false;
  /** Addresses whose accounts are gone: they read as null wherever a person is named. */
  readonly gone = new Set<string>();

  constructor(
    private readonly person: (email: string) => { name: string; image: string | null },
    private readonly readers: (threadId: string) => string[],
  ) {}

  personOf(email: string | null): Person | null {
    return email && !this.gone.has(email) ? { id: userOf(email), ...this.person(email) } : null;
  }

  /** The reader's collaboration on a thread, for its row and its own read; undefined from an older server. */
  projection(thread: CollaborationThread, who: string) {
    if (!this.served) return undefined;
    const open = this.sharedWrites;
    const ask = thread.asks.find((each) => !each.answered) ?? null;
    const askSender = ask ? (thread.turns.get(ask.turnId) ?? null) : null;
    const askLive = Boolean(ask && !ask.parked && thread.turnId === ask.turnId);
    const ownsLive = askLive && askSender === who;
    const startable = open && !askLive;
    const send = thread.stopping ? "after" : "now";
    return {
      version: 1,
      viewer: this.personOf(who),
      canWrite: open,
      live: thread.turn && thread.turnId ? { id: thread.turnId, sender: this.personOf(thread.turn), startedAt: thread.turnStartedAt ?? new Date().toISOString(), stopping: thread.stopping } : null,
      send: open ? send : "blocked",
      handoff: null,
      canPostNote: open,
      canStop: open && Boolean(thread.turn),
      ask: ask
        ? {
            id: ask.id,
            turnId: ask.turnId,
            state: askLive ? "waiting" : "parked",
            sender: this.personOf(askSender),
            answer: answerOf(ownsLive, startable),
            canDecline: ownsLive || startable,
            reason: askLive && askSender !== who ? `${this.personOf(askSender)?.name ?? "The previous sender"} can answer while this turn is running.` : null,
          }
        : null,
      queue: thread.messages
        .filter((message) => message.state === "pending" || message.state === "refused")
        .map((message) => ({ messageId: message.id, author: this.personOf(message.author), paused: false, canEdit: message.author === who, canRemove: message.author === who, canStart: false })),
      mentions: { unread: false, firstUnreadNoteId: null },
      noteHead: 0,
    };
  }

  /** The three reads of a thread the person reads: `[path, threadId, read]`. Null for any other path. */
  route(method: string, read: string, query: URLSearchParams, thread: CollaborationThread, who: string): Reply | null {
    if (method !== "GET") return null;
    if (!this.served) return { status: 404, body: { message: `Cannot GET /hosted/threads/${thread.id}/${read}`, error: "Not Found", statusCode: 404 } };
    if (read === "collaboration") return { status: 200, body: this.projection(thread, who) };
    if (read === "turn-senders") {
      const ids = [...new Set((query.get("turnIds") ?? "").split(",").map((id) => id.trim()))].filter(Boolean);
      if (!ids.length || ids.length > 100) return { status: 400, body: { message: "Name between one and a hundred turns.", statusCode: 400 } };
      const turns = ids.filter((id) => thread.turns.has(id)).map((id) => ({ id, sender: this.personOf(thread.turns.get(id) ?? null) }));
      return { status: 200, body: { turns } };
    }
    if (read === "people") {
      const q = (query.get("q") ?? "").trim().toLowerCase();
      const people = this.readers(thread.id)
        .filter((email) => !this.gone.has(email))
        .map((email) => ({ ...this.personOf(email)!, email }))
        .filter((each) => !q || each.name.toLowerCase().includes(q) || each.email.includes(q))
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id))
        .slice(0, 100);
      return { status: 200, body: { people } };
    }
    return null;
  }
}
