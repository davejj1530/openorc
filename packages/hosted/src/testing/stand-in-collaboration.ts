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

/** A handoff block as the stand-in keeps it: whose turn left it, by address, and the commands that must end. */
export interface StandInHandoff {
  code: "handoff_command" | "handoff_save";
  responsible: string | null;
  commandIds: string[];
}

/** What the projection reads of a stand-in thread. */
export interface CollaborationThread {
  id: string;
  /** Who started the thread, by address. */
  owner: string;
  /** Who started the running turn, by address; null between turns. */
  turn: string | null;
  turnId: string | null;
  /** Each turn's sender, by address; a sender removed since is left out. */
  turns: Map<string, string>;
  turnStartedAt: string | null;
  stopping: boolean;
  asks: { id: string; turnId: string; answered: boolean; parked: boolean }[];
  messages: { id: string; author: string; state: string; paused?: boolean }[];
}

/** live: the ask's own sender while its turn runs. start: a parked ask anyone who writes may answer. */
const answerOf = (ownsLive: boolean, startable: boolean) => {
  if (ownsLive) return "live";
  return startable ? "start" : "blocked";
};

/** While only joining is open: a teammate joins a running turn and nothing else; the creator sends as today. */
const joinSend = (thread: CollaborationThread, creator: boolean) => {
  if (thread.turn) return sendOf(thread);
  return creator ? "now" : "blocked";
};

/** A turn stopping takes no more messages: they wait for the next. */
const sendOf = (thread: CollaborationThread) => (thread.stopping ? "after" : "now");

export class StandInCollaboration {
  /** False: a server that predates working together. */
  served = true;
  /** Shared writing open, as the server will answer once its launch isolation is proved. */
  sharedWrites = false;
  /**
   * With `sharedWrites`, the slice before handoff: a teammate may only join the running turn it names. Their idle send,
   * Queue, Stop and Start are refused with the handoff block; a join that missed its turn waits paused for its author.
   * The creator keeps every right of today.
   */
  joinOnly = false;
  /**
   * What keeps a thread from moving to its next sender, per thread: a command of the previous sender's still running, or
   * a save that failed. It holds only someone else's new turn, never a join, and the previous sender may retry the save.
   */
  readonly handoffs = new Map<string, StandInHandoff>();
  /** The next turn a teammate starts fails its handoff this way: the message waits paused for its author. */
  failNextHandoff: StandInHandoff["code"] | null = null;
  /** The thread's last note `seq`, which every reader's collaboration carries. */
  noteHead: (threadId: string) => number = () => 0;
  /** The reader's first unread note that tags them. */
  mentionsOf: (threadId: string, who: string) => { unread: boolean; firstUnreadNoteId: string | null } = () => ({ unread: false, firstUnreadNoteId: null });
  /** Whether the server answers `GET /hosted/mentions`; an older one does not. */
  mentionSpaces = true;
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
    if (this.sharedWrites && this.joinOnly) return this.#joinProjection(thread, who);
    const open = this.sharedWrites;
    return {
      version: 1,
      viewer: this.personOf(who),
      canWrite: open,
      live: this.#live(thread),
      send: open && !(this.holds(thread, who) && !thread.turn) ? sendOf(thread) : "blocked",
      handoff: this.#blockFor(thread, who),
      canPostNote: open,
      canStop: open && Boolean(thread.turn),
      ask: this.#ask(thread, who),
      queue: thread.messages
        .filter((message) => message.state === "pending" || message.state === "refused")
        .map((message) => ({
          messageId: message.id,
          author: this.personOf(message.author),
          paused: Boolean(message.paused),
          canEdit: message.author === who,
          canRemove: message.author === who,
          canStart: open && Boolean(message.paused) && message.author === who && !thread.turn && !this.holds(thread, who),
        })),
      mentions: this.mentionsOf(thread.id, who),
      noteHead: this.noteHead(thread.id),
    };
  }

  /** Whether the thread's handoff keeps this person from starting a turn: someone else's command, or a failed save. */
  holds(thread: { id: string }, who: string): boolean {
    const block = this.handoffs.get(thread.id);
    return Boolean(block && block.responsible !== who);
  }

  /** The handoff refusal of a new turn, in the server's words: 409 with the block, this thread's or the one given. */
  handoffRefusal(thread: { id: string }, who: string, given?: { code: string; message: string }): Reply {
    const block = given ?? this.#blockFor(thread, who)!;
    return { status: 409, body: { code: block.code, message: block.message, block, statusCode: 409 } };
  }

  /** The block as this person reads it; the previous sender's own command holds nobody's turn but someone else's. */
  #blockFor(thread: { id: string }, who: string) {
    const block = this.handoffs.get(thread.id);
    if (!block || (block.code === "handoff_command" && block.responsible === who)) return null;
    const responsible = this.personOf(block.responsible);
    const first = responsible?.name.split(" ")[0];
    const message =
      block.code === "handoff_command"
        ? `${first ? `${first}'s` : "The previous sender's"} command is still running. Stop it before starting your turn.`
        : `The thread's work could not be saved.${first ? ` ${first} can retry the save.` : ""}`;
    return { code: block.code, message, responsible, commandIds: block.commandIds, retrySave: block.code === "handoff_save" && block.responsible === who };
  }

  /**
   * Once anyone who writes may answer: an answer names the phase it saw, and one that has changed is refused; a live ask
   * is its turn's sender's to answer; while only joining is open, a teammate answers nothing. Null when it may go on, and
   * always while shared writing is closed, when only the thread's creator answers.
   */
  answerRefusal(thread: CollaborationThread, ask: CollaborationThread["asks"][number], who: string, body: Record<string, unknown>): Reply | null {
    if (!this.sharedWrites) return null;
    if (this.joinOnly && thread.owner !== who) return this.handoffRefusal(thread, who, this.joinBlock(thread));
    const live = !ask.parked && thread.turnId === ask.turnId;
    const sender = thread.turns.get(ask.turnId) ?? null;
    const changed = { status: 409, body: { code: "ask_changed", message: "This request changed. Check it again before answering.", statusCode: 409 } };
    if (typeof body["expectedState"] === "string") {
      if (body["expectedState"] !== (live ? "waiting" : "parked") || body["expectedTurnId"] !== ask.turnId) return changed;
    } else if (sender !== who) return changed;
    if (!live || sender === who) return null;
    const name = this.personOf(sender)?.name ?? "The previous sender";
    return { status: 403, body: { code: "ask_sender_only", message: `${name} can answer while this turn is running.`, statusCode: 403 } };
  }

  /**
   * Whether an answer starts a turn: a parked one does, and so do words sent instead; a bare denial closes the ask for
   * nothing. An ask is parked once its turn is no longer the one running, as its projection reads it.
   */
  answerStarts(thread: CollaborationThread, ask: CollaborationThread["asks"][number], body: Record<string, unknown>): boolean {
    const parked = ask.parked || thread.turnId !== ask.turnId;
    const words = typeof body["message"] === "string" && body["message"].trim().length > 0;
    return parked && (body["decision"] !== "deny" || words);
  }

  /** The block a teammate meets for anything that would start a turn while only joining is open. */
  joinBlock(thread: CollaborationThread) {
    const first = this.personOf(thread.owner)?.name.split(" ")[0];
    return {
      code: "handoff_unavailable",
      message: first ? `Only ${first} can run the agent in this cloud thread for now.` : "The agent can't run in this cloud thread for now.",
      responsible: this.personOf(thread.owner),
      commandIds: [],
      retrySave: false,
    };
  }

  #joinProjection(thread: CollaborationThread, who: string) {
    const creator = who === thread.owner;
    return {
      version: 1,
      viewer: this.personOf(who),
      canWrite: true,
      live: this.#live(thread),
      send: joinSend(thread, creator),
      handoff: creator ? null : this.joinBlock(thread),
      canPostNote: false,
      canStop: creator && Boolean(thread.turn),
      ask: this.#ask(thread, who, creator),
      queue: thread.messages
        .filter((message) => message.state === "pending" || message.state === "refused")
        .map((message) => ({
          messageId: message.id,
          author: this.personOf(message.author),
          paused: Boolean(message.paused),
          canEdit: message.author === who,
          canRemove: message.author === who,
          canStart: creator && Boolean(message.paused) && message.author === who && !thread.turn,
        })),
      mentions: this.mentionsOf(thread.id, who),
      noteHead: this.noteHead(thread.id),
    };
  }

  #live(thread: CollaborationThread) {
    if (!thread.turn || !thread.turnId) return null;
    return { id: thread.turnId, sender: this.personOf(thread.turn), startedAt: thread.turnStartedAt ?? new Date().toISOString(), stopping: thread.stopping };
  }

  /** The open ask: live while its turn runs, answerable then only by its sender; parked after, by anyone who writes. */
  #ask(thread: CollaborationThread, who: string, mayStart = this.sharedWrites) {
    const ask = thread.asks.find((each) => !each.answered);
    if (!ask) return null;
    const sender = thread.turns.get(ask.turnId) ?? null;
    const live = !ask.parked && thread.turnId === ask.turnId;
    const ownsLive = live && sender === who;
    const startable = mayStart && !live;
    return {
      id: ask.id,
      turnId: ask.turnId,
      state: live ? "waiting" : "parked",
      sender: this.personOf(sender),
      answer: answerOf(ownsLive, startable),
      canDecline: ownsLive || startable,
      reason: live && sender !== who ? `${this.personOf(sender)?.name ?? "The previous sender"} can answer while this turn is running.` : null,
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
