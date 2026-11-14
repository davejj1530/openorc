/**
 * Who sent each turn and who wrote each message of the threads a window has read, for the transcript's turn heads and
 * prompts. Held in memory for the signed-in account and never kept:
 *
 *   heard    per thread, read off the log as its pages and frames pass: the turn of each transcript block (by the id
 *            the transcript gives it: a message's, a call's, an ask's) and the author of each person's message
 *   senders  per thread, the sender of each turn the server named: through the turn-senders read, or the live turn's
 *            and the ask's own, which the row already carries. Null is a former member
 *   people   identities the app has seen, so an author's id becomes a face and a name; the thread's roster is read only
 *            for an author still unnamed. An author no read names is a former member
 *
 * A turn's sender is never the current payer read after the fact, and a message's author is never its turn's sender.
 */
import type { ThreadAuthors, ThreadCollaboration, ThreadPerson } from "@openorc/protocol";
import type { Requests } from "./session.js";
import { appMessageId } from "./translate.js";
import { COLLABORATION_ROUTES, SENDERS_PER_READ, toPerson } from "./wire-collaboration.js";
import type { WireEvent } from "./wire.js";

interface Heard {
  turnOf: Map<string, string>;
  authors: Map<string, string>;
}

/** The ids the transcript names an event's block by. */
function blockKeys(event: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const text = (key: string) => (typeof event[key] === "string" ? (event[key] as string) : null);
  const message = text("messageId");
  if (message) keys.push(event["role"] === "user" ? appMessageId(message) : message);
  const call = text("toolCallId");
  if (call) keys.push(call);
  const approval = text("approvalId");
  if (approval) keys.push(`approval-${approval}`);
  return keys;
}

export class ThreadVoices {
  readonly #heard = new Map<string, Heard>();
  readonly #senders = new Map<string, Map<string, ThreadPerson | null>>();
  /** Turns a sender read left out, so they are not asked about again: no one is named for them. */
  readonly #unnamed = new Set<string>();
  readonly #people = new Map<string, ThreadPerson>();
  readonly #rosters = new Set<string>();

  /** Takes in a stretch of a thread's log. True when it named a turn or an author not heard before. */
  observe(threadId: string, events: readonly WireEvent[]): boolean {
    const heard = this.#heard.get(threadId) ?? { turnOf: new Map(), authors: new Map() };
    this.#heard.set(threadId, heard);
    let learned = false;
    for (const { turnId, by, event } of events) {
      for (const key of turnId ? blockKeys(event) : []) {
        if (heard.turnOf.get(key) === turnId) continue;
        heard.turnOf.set(key, turnId!);
        learned = true;
      }
      if (!by || event["type"] !== "message.completed" || event["role"] !== "user" || typeof event["messageId"] !== "string") continue;
      const id = appMessageId(event["messageId"]);
      if (heard.authors.get(id) === by) continue;
      heard.authors.set(id, by);
      learned = true;
    }
    return learned;
  }

  /** People named anywhere a row names them: the reader, the live turn's and the ask's senders, the queue's authors. */
  meet(collaboration: ThreadCollaboration | undefined, starter: ThreadPerson | null): void {
    const named = [starter, collaboration?.viewer, collaboration?.live?.sender, collaboration?.ask?.sender, ...(collaboration?.queue.map((each) => each.author) ?? [])];
    for (const person of named) if (person) this.#people.set(person.id, person);
  }

  /**
   * The thread's authors and senders as far as its log was read. Asks the server for the senders of turns not named yet,
   * at most a hundred at a time, and for the roster once while an author's id has no name. A failed read fails.
   */
  async read(threadId: string, on: Requests, collaboration: ThreadCollaboration): Promise<ThreadAuthors> {
    const heard = this.#heard.get(threadId) ?? { turnOf: new Map<string, string>(), authors: new Map<string, string>() };
    const senders = this.#senders.get(threadId) ?? new Map<string, ThreadPerson | null>();
    this.#senders.set(threadId, senders);
    if (collaboration.live) senders.set(collaboration.live.id, collaboration.live.sender);
    if (collaboration.ask) senders.set(collaboration.ask.turnId, collaboration.ask.sender);
    const unnamed = [...new Set(heard.turnOf.values())].filter((turnId) => !senders.has(turnId) && !this.#unnamed.has(`${threadId}:${turnId}`));
    for (let at = 0; at < unnamed.length; at += SENDERS_PER_READ) {
      const asked = unnamed.slice(at, at + SENDERS_PER_READ);
      const { turns } = await on.request(COLLABORATION_ROUTES.turnSenders(threadId, asked));
      for (const { id, sender } of turns) senders.set(id, sender ? toPerson(sender) : null);
      for (const id of asked) if (!senders.has(id)) this.#unnamed.add(`${threadId}:${id}`);
    }
    for (const sender of senders.values()) if (sender) this.#people.set(sender.id, sender);
    if ([...heard.authors.values()].some((id) => !this.#people.has(id)) && !this.#rosters.has(threadId)) {
      const { people } = await on.request(COLLABORATION_ROUTES.people(threadId, ""));
      for (const person of people) this.#people.set(person.id, toPerson(person));
      this.#rosters.add(threadId);
    }
    return {
      viewer: collaboration.viewer,
      turnOf: Object.fromEntries(heard.turnOf),
      senders: Object.fromEntries(senders),
      authors: Object.fromEntries([...heard.authors].map(([messageId, id]) => [messageId, this.#people.get(id) ?? null])),
    };
  }

  /** Names changed: the senders and people are read again, the log as heard stays. */
  renamed(): void {
    this.#senders.clear();
    this.#unnamed.clear();
    this.#people.clear();
    this.#rosters.clear();
  }

  /** Threads no longer read, or every thread when the account changes. */
  forget(threadIds?: readonly string[]): void {
    if (!threadIds) {
      this.#heard.clear();
      this.renamed();
      return;
    }
    for (const id of threadIds) {
      this.#heard.delete(id);
      this.#senders.delete(id);
      this.#rosters.delete(id);
    }
  }
}
