/**
 * Keeps the frames of the threads a window looks at coming, in order, with none lost and none twice.
 *
 * Windows take every frame and never say which runs they want, so interest is read off their calls: a call that reads
 * a thread's log follows the thread for five minutes, and every frame handed on renews that. Interest becomes the
 * server's `hosted:watch`.
 *
 * State, written only here:
 *   cursors   the highest seq handed to the app, per thread. Kept after a watch ends, so a thread watched again is
 *             healed from where it stopped instead of skipping what happened between.
 *   watched   the threads of interest, and the timer that ends each one's interest.
 *   joined    the threads in the server's room on this socket session; a new session has none.
 *   joining   frames that arrived while a watch was being answered, handed on once it is.
 *
 * The invariant: for a thread with a cursor, the app has been handed every event the server kept with seq <= cursor,
 * each once, in seq order. A page a window reads for itself may run ahead of the cursor; the window drops the overlap
 * by `eventId`, which translate.ts keeps as the server's.
 */
import { hostedRunId } from "@openorc/protocol";
import type { HostedDeps } from "./index.js";
import type { Requests, Session } from "./session.js";
import { toFrame } from "./translate.js";
import { ROUTES, SOCKET, wireChange, wireFrame, wireWatched, type WireEvent } from "./wire.js";

export const FOLLOW_MS = 5 * 60_000;
/** The most events one read of a thread's log takes. */
export const READ_LIMIT = 2000;

export class Follower {
  readonly #cursors = new Map<string, number>();
  readonly #watched = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #joined = new Set<string>();
  readonly #joining = new Map<string, Promise<void>>();
  readonly #held = new Map<string, WireEvent[][]>();
  readonly #healing = new Map<string, Promise<void>>();
  readonly #tickets = new Map<string, symbol>();

  /** `on`: requests about a thread, in its space. */
  constructor(private readonly deps: { session: Session; on(threadId: string): Requests } & Pick<HostedDeps, "push" | "log">) {
    let generation = deps.session.generation;
    deps.session.onSocket(SOCKET.events, (body) => this.#onFrame(body));
    deps.session.onSocket(SOCKET.threadChanged, (body) => this.#onChanged(body));
    deps.session.onChange((change) => {
      if (!deps.session.state.signedIn || generation !== deps.session.generation) this.forget();
      else if (change === "connected") this.#rejoin();
      generation = deps.session.generation;
    });
  }

  /**
   * Called before every read of a thread's log. Resolves once its frames are coming, so the page read next and the
   * frames leave no hole between them. Resolves all the same when the server is out of reach: the read then fails for
   * its own reason.
   */
  async follow(threadId: string): Promise<void> {
    this.#renew(threadId);
    if (this.#joined.has(threadId)) return;
    const ticket = this.#tickets.get(threadId) ?? Symbol();
    this.#tickets.set(threadId, ticket);
    const joining = this.#joining.get(threadId) ?? this.#join(threadId, ticket);
    this.#joining.set(threadId, joining);
    await joining;
  }

  /** Revocation or sign-out discards pending work as well as already joined rooms. */
  forget(threadIds: readonly string[] = [...this.#tickets.keys()]): void {
    for (const id of threadIds) {
      clearTimeout(this.#watched.get(id));
      this.#watched.delete(id);
      this.#cursors.delete(id);
      this.#joined.delete(id);
      this.#held.delete(id);
      this.#joining.delete(id);
      this.#healing.delete(id);
      this.#tickets.delete(id);
    }
  }

  async #join(threadId: string, ticket: symbol): Promise<void> {
    this.#held.set(threadId, []);
    try {
      const reply = await this.deps.session.ask(SOCKET.watch, threadId, wireWatched);
      if (!reply.ok || this.#tickets.get(threadId) !== ticket) return;
      this.#joined.add(threadId);
      const known = this.#cursors.get(threadId);
      // The first time, the page the window reads next covers up to here; after a gap, what passed is read now.
      if (known === undefined) this.#cursors.set(threadId, reply.head);
      else if (reply.head > known) await this.#heal(threadId);
      if (this.#tickets.get(threadId) !== ticket) return;
      for (const events of this.#held.get(threadId) ?? []) this.#take(threadId, events);
    } catch {
      // Out of reach: the read that follows fails in its own words, and a new session joins again.
    } finally {
      if (this.#tickets.get(threadId) === ticket) {
        this.#held.delete(threadId);
        this.#joining.delete(threadId);
      }
    }
  }

  /** The server's `hosted:events`: a stored batch, handed on after what the app already has. */
  #onFrame(body: unknown): void {
    const frame = wireFrame.safeParse(body);
    if (!frame.success) return;
    const { threadId, events } = frame.data;
    const held = this.#held.get(threadId);
    if (held) return void held.push(events);
    if (this.#joined.has(threadId)) this.#take(threadId, events);
  }

  #take(threadId: string, events: WireEvent[]): void {
    const last = this.#cursors.get(threadId);
    if (last === undefined) return;
    // A frame was lost on the way: the read brings these events too.
    if (events[0]!.seq > last + 1) return void this.#heal(threadId);
    this.#hand(
      threadId,
      events.filter((event) => event.seq > last),
    );
  }

  /** The server's `hosted:changed`: its head tells a follower that lost the last frame of a turn that it is behind. */
  #onChanged(body: unknown): void {
    const change = wireChange.safeParse(body);
    if (!change.success || !this.#joined.has(change.data.threadId)) return;
    if (change.data.head > (this.#cursors.get(change.data.threadId) ?? change.data.head)) void this.#heal(change.data.threadId);
  }

  /**
   * Reads the log after the cursor up to the head and hands it on. One heal per thread at a time; a second ask joins
   * it. If a read fails, the cursor is forgotten and the windows are told the run has a gap, so they read it again when
   * the server answers.
   */
  #heal(threadId: string): Promise<void> {
    const running = this.#healing.get(threadId);
    if (running) return running;
    const ticket = this.#tickets.get(threadId);
    if (!ticket) return Promise.resolve();
    const healing = this.#readOn(threadId, ticket).finally(() => {
      if (this.#healing.get(threadId) === healing) this.#healing.delete(threadId);
    });
    this.#healing.set(threadId, healing);
    return healing;
  }

  async #readOn(threadId: string, ticket: symbol): Promise<void> {
    try {
      for (;;) {
        const after = this.#cursors.get(threadId);
        if (after === undefined || this.#tickets.get(threadId) !== ticket) return;
        const page = await this.deps.on(threadId).request(ROUTES.events(threadId, { after }, READ_LIMIT));
        if (this.#tickets.get(threadId) !== ticket) return;
        this.#hand(threadId, page.events);
        if (page.events.length < READ_LIMIT || (this.#cursors.get(threadId) ?? 0) >= page.head) return;
      }
    } catch (error) {
      if (this.#tickets.get(threadId) !== ticket) return;
      this.deps.log.warn(`OpenOrc Cloud thread ${threadId} lost frames: ${error instanceof Error ? error.message : String(error)}`);
      this.#cursors.delete(threadId);
      this.#joined.delete(threadId);
      this.deps.push({ type: "gap", runIds: [hostedRunId(threadId)] });
    }
  }

  #hand(threadId: string, events: WireEvent[]): void {
    if (!events.length) return;
    this.#cursors.set(threadId, events.at(-1)!.seq);
    const frame = toFrame(threadId, events);
    if (frame) this.deps.push({ type: "frame", frame });
    this.#renew(threadId);
  }

  /** A new socket session: the server's rooms are gone. Every thread still of interest is joined again and healed. */
  #rejoin(): void {
    this.#joined.clear();
    this.#tickets.clear();
    this.#joining.clear();
    this.#healing.clear();
    this.#held.clear();
    for (const threadId of this.#watched.keys()) void this.follow(threadId);
  }

  /** Interest lasts five minutes past the last read or frame, then the room is left. The cursor stays. */
  #renew(threadId: string): void {
    clearTimeout(this.#watched.get(threadId));
    const timer = setTimeout(() => {
      this.#watched.delete(threadId);
      this.#joined.delete(threadId);
      this.deps.session.ask(SOCKET.unwatch, threadId, wireWatched.partial()).catch(() => undefined);
    }, FOLLOW_MS);
    timer.unref?.();
    this.#watched.set(threadId, timer);
  }
}
