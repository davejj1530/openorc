/**
 * The stand-in's notes, with the rules the app depends on, as the server does: a note tags at
 * least one person who reads the thread's project, by ranges of its text; the same id again is the same note, another
 * note under it is refused; a note takes its place after the thread's events stored so far; pages run by `seq`. A note
 * starts nothing and reaches no agent. Each reader reads a note by marking it read by id, never by a high-water mark, so a
 * note they skipped stays unread; their first unread note that tags them is their thread's mention. Refusals are in the
 * server's words.
 */
import { userOf } from "./stand-in-spaces.js";

type Reply = { status: number; body: unknown };
type Person = { id: string; name: string; image: string | null };

interface StoredNote {
  id: string;
  seq: number;
  author: string;
  text: string;
  mentions: { userId: string; start: number; end: number }[];
  replyTo: string | null;
  createdAt: string;
  afterEventSeq: number;
}

const refused = (status: number, code: string, message: string): Reply => ({ status, body: { code, message, statusCode: status } });
const gone = () => refused(404, "note_gone", "That note isn't here.");
const emailOf = (userId: string) => (userId.startsWith("user-") ? userId.slice(5) : null);

/** Ranges sorted, apart, inside the text and each naming some of it. */
function rangesHold(text: string, mentions: unknown): mentions is StoredNote["mentions"] {
  if (!Array.isArray(mentions) || mentions.length === 0 || mentions.length > 20) return false;
  let at = 0;
  for (const mention of mentions as { userId?: unknown; start?: unknown; end?: unknown }[]) {
    if (typeof mention.userId !== "string" || typeof mention.start !== "number" || typeof mention.end !== "number") return false;
    if (mention.start < at || mention.end <= mention.start || mention.end > text.length) return false;
    at = mention.end;
  }
  return true;
}

export class StandInNotes {
  readonly #notes = new Map<string, StoredNote[]>();
  /** The notes each reader of each thread has read, by id. */
  readonly #read = new Map<string, Map<string, Set<string>>>();

  constructor(
    private readonly personOf: (email: string | null) => Person | null,
    private readonly readers: (threadId: string) => string[],
  ) {}

  /** The last note's `seq` in the thread, 0 with none. */
  head(threadId: string): number {
    return this.#notes.get(threadId)?.at(-1)?.seq ?? 0;
  }

  /** The reader's first unread note that tags them, which their row marks. */
  mentionsOf(threadId: string, who: string): { unread: boolean; firstUnreadNoteId: string | null } {
    const first = (this.#notes.get(threadId) ?? []).find((note) => this.#tags(note, who) && !this.#seen(threadId, who).has(note.id));
    return { unread: Boolean(first), firstUnreadNoteId: first?.id ?? null };
  }

  /** The spaces, in id order, of the threads the person reads where a note tags them unread. */
  unreadSpaces(threads: Iterable<{ id: string; space: string }>, who: string): { spaceId: string }[] {
    const spaces = new Set([...threads].filter((thread) => this.mentionsOf(thread.id, who).unread).map((thread) => thread.space));
    return [...spaces].sort().map((spaceId) => ({ spaceId }));
  }

  /**
   * `POST` posts one, `GET` pages them, `PUT .../read` marks the ones the reader saw; `changed` is told of a note stored
   * or read, for the thread's readers to hear.
   */
  route(method: string, read: boolean, request: { query: URLSearchParams; body: Record<string, unknown> }, thread: { id: string; head: number }, who: string, changed: () => void): Reply | null {
    const { query, body } = request;
    if (read) return method === "PUT" ? this.#markRead(thread.id, who, body["ids"], changed) : null;
    if (method === "GET") return this.#page(thread.id, query, who);
    if (method !== "POST") return null;
    const reply = this.#post(thread, who, body);
    if (reply.status === 200) changed();
    return reply;
  }

  #markRead(threadId: string, who: string, ids: unknown, changed: () => void): Reply {
    const notes = new Set((this.#notes.get(threadId) ?? []).map((note) => note.id));
    // As the server's validation answers it: a plain 400 with no code of its own.
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || new Set(ids).size !== ids.length)
      return { status: 400, body: { statusCode: 400, message: "Name between one and a hundred notes.", error: "Bad Request" } };
    if (ids.some((id) => !notes.has(id as string))) return gone();
    const seen = this.#seen(threadId, who);
    for (const id of ids as string[]) seen.add(id);
    changed();
    return { status: 204, body: null };
  }

  #seen(threadId: string, who: string): Set<string> {
    const thread = this.#read.get(threadId) ?? new Map<string, Set<string>>();
    this.#read.set(threadId, thread);
    const seen = thread.get(who) ?? new Set<string>();
    thread.set(who, seen);
    return seen;
  }

  /** A note tags the person, and is someone else's: tagging yourself is no mention. */
  #tags(note: StoredNote, who: string): boolean {
    return note.author !== who && note.mentions.some((mention) => mention.userId === userOf(who));
  }

  #post(thread: { id: string; head: number }, who: string, body: Record<string, unknown>): Reply {
    const notes = this.#notes.get(thread.id) ?? [];
    const text = typeof body["text"] === "string" ? body["text"] : "";
    const replyTo = typeof body["replyTo"] === "string" ? body["replyTo"] : null;
    if (body["fileIds"] !== undefined) return refused(400, "note_files_unsupported", "Remove the attachments to post a note.");
    if (!Array.isArray(body["mentions"]) || body["mentions"].length === 0) return refused(400, "note_needs_person", "Tag a person to post a note.");
    const mentions = body["mentions"];
    const known = notes.find((note) => note.id === body["id"]);
    if (known) {
      const same = known.author === who && known.text === text && known.replyTo === replyTo && JSON.stringify(known.mentions) === JSON.stringify(mentions);
      return same ? { status: 200, body: { note: this.#wire(thread.id, known, who) } } : refused(409, "note_id_taken", "That note id belongs to another note.");
    }
    return this.#tagsRefusal(thread.id, notes, text, mentions, replyTo) ?? this.#store(thread, who, notes, { id: String(body["id"]), text, mentions, replyTo });
  }

  /** Tags that name no span, someone without the thread's project, or a reply to a note that is not here. */
  #tagsRefusal(threadId: string, notes: StoredNote[], text: string, mentions: unknown, replyTo: string | null): Reply | null {
    if (!text || !rangesHold(text, mentions)) return refused(400, "note_mentions_invalid", "Choose the people to tag again.");
    const readers = new Set(this.readers(threadId));
    if (mentions.some((mention) => !readers.has(emailOf(mention.userId) ?? ""))) {
      return refused(409, "note_recipient_unavailable", "Someone you tagged no longer has access to this project. Choose the people again.");
    }
    if (replyTo && !notes.some((note) => note.id === replyTo)) return gone();
    return null;
  }

  /** The note stored after the thread's events so far. */
  #store(thread: { id: string; head: number }, who: string, notes: StoredNote[], input: { id: string; text: string; mentions: StoredNote["mentions"]; replyTo: string | null }): Reply {
    const { id, text, mentions, replyTo } = input;
    const note: StoredNote = {
      id,
      seq: this.head(thread.id) + 1,
      author: who,
      text,
      mentions: mentions.map(({ userId, start, end }) => ({ userId, start, end })),
      replyTo,
      createdAt: new Date().toISOString(),
      afterEventSeq: thread.head,
    };
    this.#notes.set(thread.id, [...notes, note]);
    return { status: 200, body: { note: this.#wire(thread.id, note, who) } };
  }

  /** At most one bound: the newest page, the notes after or before a `seq`, or those around one note, which must be here. */
  #page(threadId: string, query: URLSearchParams, who: string): Reply {
    const notes = this.#notes.get(threadId) ?? [];
    if (query.get("around") !== null && !notes.some((note) => note.id === query.get("around"))) return gone();
    const limit = Math.min(200, Math.max(1, Number(query.get("limit") ?? 50)));
    const after = query.get("after");
    const before = query.get("before");
    const around = query.get("around");
    let from: number;
    if (after !== null) from = notes.findIndex((note) => note.seq > Number(after));
    else if (before !== null) from = Math.max(0, notes.filter((note) => note.seq < Number(before)).length - limit);
    // Around a note: it sits in the middle where there is room, and near an end the page is still `limit` long.
    else if (around !== null) from = Math.max(0, Math.min(notes.length - limit, notes.findIndex((note) => note.id === around) - Math.floor((limit - 1) / 2)));
    else from = Math.max(0, notes.length - limit);
    if (from < 0) from = notes.length;
    const end = before !== null ? Math.min(notes.length, notes.filter((note) => note.seq < Number(before)).length) : Math.min(notes.length, from + limit);
    const page = notes.slice(from, end);
    return { status: 200, body: { notes: page.map((note) => this.#wire(threadId, note, who)), head: this.head(threadId), hasBefore: from > 0, hasAfter: end < notes.length } };
  }

  #wire(threadId: string, note: StoredNote, who: string) {
    return {
      ...note,
      threadId,
      author: this.personOf(note.author),
      mentions: note.mentions.map((mention) => ({ ...mention, person: this.personOf(emailOf(mention.userId)) })),
      mentionedYou: this.#tags(note, who),
      read: note.author === who || this.#seen(threadId, who).has(note.id),
    };
  }
}
