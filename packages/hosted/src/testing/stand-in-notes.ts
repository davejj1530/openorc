/**
 * The stand-in's notes, with the real server's rules the app depends on (the contract's notes section): a note tags at
 * least one person who reads the thread's project, by ranges of its text; the same id again is the same note, another
 * note under it is refused; a note takes its place after the thread's events stored so far; pages run by `seq`. A note
 * starts nothing and reaches no agent. Refusals are in the server's words.
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

  constructor(
    private readonly personOf: (email: string | null) => Person | null,
    private readonly readers: (threadId: string) => string[],
  ) {}

  /** The last note's `seq` in the thread, 0 with none. */
  head(threadId: string): number {
    return this.#notes.get(threadId)?.at(-1)?.seq ?? 0;
  }

  /** `POST` posts one, `GET` pages them; `posted` is told of a note stored, for the thread's readers to hear. */
  route(method: string, query: URLSearchParams, body: Record<string, unknown>, thread: { id: string; head: number }, who: string, posted: () => void): Reply | null {
    if (method === "GET") return { status: 200, body: this.#page(thread.id, query, who) };
    if (method !== "POST") return null;
    const reply = this.#post(thread, who, body);
    if (reply.status === 200) posted();
    return reply;
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
    if (replyTo && !notes.some((note) => note.id === replyTo)) return refused(404, "note_gone", "That note isn't here.");
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

  /** At most one bound: the newest page, the notes after or before a `seq`, or those around one note. */
  #page(threadId: string, query: URLSearchParams, who: string) {
    const notes = this.#notes.get(threadId) ?? [];
    const limit = Math.min(200, Math.max(1, Number(query.get("limit") ?? 50)));
    const after = query.get("after");
    const before = query.get("before");
    const around = query.get("around");
    let from: number;
    if (after !== null) from = notes.findIndex((note) => note.seq > Number(after));
    else if (before !== null) from = Math.max(0, notes.filter((note) => note.seq < Number(before)).length - limit);
    else if (around !== null) from = Math.max(0, notes.findIndex((note) => note.id === around) - Math.floor((limit - 1) / 2));
    else from = Math.max(0, notes.length - limit);
    if (from < 0) from = notes.length;
    const end = before !== null ? Math.min(notes.length, notes.filter((note) => note.seq < Number(before)).length) : Math.min(notes.length, from + limit);
    const page = notes.slice(from, end);
    return { notes: page.map((note) => this.#wire(threadId, note, who)), head: this.head(threadId), hasBefore: from > 0, hasAfter: end < notes.length };
  }

  #wire(threadId: string, note: StoredNote, who: string) {
    return {
      ...note,
      threadId,
      author: this.personOf(note.author),
      mentions: note.mentions.map((mention) => ({ ...mention, person: this.personOf(emailOf(mention.userId)) })),
      mentionedYou: note.author !== who && note.mentions.some((mention) => mention.userId === userOf(who)),
      read: false,
    };
  }
}
