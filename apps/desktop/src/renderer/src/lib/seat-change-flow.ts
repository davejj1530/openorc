import type { SeatOperation } from "@openorc/protocol";

/** The protocol's own reader of a value that crossed from the core. */
interface Reader<V> {
  parse(value: unknown): V;
  safeParse(value: unknown): { success: true; data: V } | { success: false };
}

export interface SeatChangeWork<R> {
  request: R;
  operation: SeatOperation | null;
  error: string | null;
}
/** One seat change in this window: what is asked, the server's review of it, and the journaled request once confirmed. */
export interface SeatChangeState<T, P, W> {
  state: "draft" | "preview" | "submitting" | "pending" | "complete" | "failed";
  target: T | null;
  preview: P | null;
  work: W | null;
  reviewing: boolean;
  error: string | null;
}
export interface SeatChangeDeps<T, P, R, W> {
  current(): boolean;
  now(): number;
  id(): string;
  preview(target: T): Promise<P>;
  send(request: R): Promise<W>;
  read(id: string): Promise<W | null>;
}
/** What differs between moving a seat and changing how many there are. */
export interface SeatChangeKind<T, P, R, W> {
  preview: Reader<P>;
  work: Reader<W>;
  /** The review is of this target. */
  answers(preview: P, target: T): boolean;
  /** The exact request a confirmed review becomes. */
  request(preview: P, id: string): R;
  /** What a remembered review was for, when it is the review this work was sent with; null otherwise. */
  target(preview: P, work: W): T | null;
  /** The server's words for a review that no longer holds. */
  stale: string;
}

const UNCONFIRMED = "The seat change could not be confirmed. Try again.";

/**
 * Draft, review, sending, then pending, complete or failed. A review belongs to its target and expires; a change is
 * journaled by the core before it is sent, so a lost reply stays pending and is read, and only a press sends again.
 */
export class SeatChangeFlow<T, P extends { token: string; expiresAt: number }, R extends { body: { id: string; previewToken: string } }, W extends SeatChangeWork<R>> {
  #snapshot: SeatChangeState<T, P, W> = empty();
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #running: Promise<void> | null = null;
  #expiry: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  constructor(
    private readonly kind: SeatChangeKind<T, P, R, W>,
    private readonly deps: SeatChangeDeps<T, P, R, W>,
  ) {}
  getSnapshot = (): SeatChangeState<T, P, W> => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  select(target: T | null): void {
    if (!this.#canReview()) return;
    ++this.#generation;
    this.#clearExpiry();
    this.#publish({ ...empty(), target: structuredClone(target) });
  }

  async review(): Promise<void> {
    if (!this.#canReview() || this.#snapshot.target === null) return;
    const target = structuredClone(this.#snapshot.target);
    const generation = ++this.#generation;
    this.#clearExpiry();
    this.#publish({ state: "draft", reviewing: true, preview: null, work: null, error: null });
    try {
      if (!this.#live(generation)) return;
      const preview = this.kind.preview.parse(await this.deps.preview(target));
      if (!this.#live(generation)) return;
      if (!this.kind.answers(preview, target) || preview.expiresAt <= this.deps.now()) throw new Error(this.kind.stale);
      this.#publish({ state: "preview", preview, reviewing: false });
      if (this.#live(generation)) this.#expiry = setTimeout(() => this.#expire(), preview.expiresAt - this.deps.now());
    } catch (error) {
      if (this.#live(generation)) this.#publish({ state: "failed", reviewing: false, error: words(error) });
    }
  }

  async confirm(): Promise<void> {
    if (!this.#current()) return;
    if (this.#running) return this.#running;
    this.#expire();
    const { state, preview } = this.#snapshot;
    if (state !== "preview" || !preview) return;
    this.#clearExpiry();
    return this.#run(this.kind.work.parse({ request: this.kind.request(preview, this.deps.id()), operation: null, error: null }), true);
  }

  async retry(): Promise<void> {
    if (!this.#current()) return;
    const { state, work } = this.#snapshot;
    if (state === "complete") return this.refresh();
    if (state === "pending" && work) return this.#run(work, true);
  }

  async refresh(): Promise<void> {
    if (!this.#current()) return;
    const { state, work } = this.#snapshot;
    if (work && (state === "pending" || state === "complete")) return this.#run(work, false);
  }

  resume(input: W, preview?: P): void {
    if (!this.#current() || this.#running) return;
    const work = this.kind.work.parse(input);
    const previous = this.#snapshot.work;
    if (previous && previous.request.body.id !== work.request.body.id) return;
    if (previous?.operation?.state === "complete" && work.operation?.state !== "complete") return;
    this.#clearExpiry();
    ++this.#generation;
    const target = preview && preview.token === work.request.body.previewToken ? this.kind.target(preview, work) : null;
    this.#snapshot = { ...empty(), preview: target === null ? null : (preview ?? null), target };
    this.#accept(work);
  }

  #run(work: W, send: boolean): Promise<void> {
    if (this.#running) return this.#running;
    const generation = this.#generation;
    const running = Promise.resolve()
      .then(async () => {
        if (!this.#live(generation)) return;
        try {
          const result = send ? await this.deps.send(structuredClone(work.request)) : await this.deps.read(work.request.body.id);
          if (this.#live(generation) && result) this.#receive(work, result);
        } catch (error) {
          if (this.#live(generation)) this.#accept({ ...work, error: words(error) });
        }
      })
      .finally(() => {
        if (this.#running === running) this.#running = null;
      });
    this.#running = running;
    if (send) this.#publish({ state: "submitting", work, error: null });
    return running;
  }

  #receive(previous: W, result: W): void {
    const parsed = this.kind.work.safeParse(result);
    if (!parsed.success || JSON.stringify(parsed.data.request) !== JSON.stringify(previous.request)) {
      this.#accept({ ...previous, error: UNCONFIRMED });
      return;
    }
    if (previous.operation?.state === "complete" && parsed.data.operation?.state !== "complete") return;
    this.#accept(parsed.data);
  }

  #accept(work: W): void {
    const state = work.operation?.state ?? "pending";
    this.#publish({ state, work, reviewing: false, error: work.error ?? work.operation?.message ?? null });
  }

  #expire(): void {
    const { state, preview } = this.#snapshot;
    if (state !== "preview" || !preview || preview.expiresAt > this.deps.now()) return;
    this.#clearExpiry();
    this.#publish({ state: "draft", preview: null, error: this.kind.stale });
  }

  revoke(): void {
    this.#closed = true;
    ++this.#generation;
    this.#clearExpiry();
    this.#publish(empty());
  }

  close(): void {
    this.revoke();
    this.#listeners.clear();
  }

  #clearExpiry(): void {
    if (this.#expiry) clearTimeout(this.#expiry);
    this.#expiry = null;
  }
  #canReview(): boolean {
    return this.#current() && ["draft", "preview", "failed"].includes(this.#snapshot.state);
  }
  #live(generation: number): boolean {
    return this.#current() && generation === this.#generation;
  }
  #current(): boolean {
    if (this.#closed) return false;
    if (this.deps.current()) return true;
    this.revoke();
    return false;
  }
  #publish(update: Partial<SeatChangeState<T, P, W>>): void {
    this.#snapshot = { ...this.#snapshot, ...update };
    this.#listeners.forEach((listener) => listener());
  }
}

const empty = <T, P, W>(): SeatChangeState<T, P, W> => ({ state: "draft", target: null, preview: null, work: null, reviewing: false, error: null });
const words = (error: unknown) => (error instanceof Error ? error.message : UNCONFIRMED);
