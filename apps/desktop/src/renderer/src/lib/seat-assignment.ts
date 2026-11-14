import { OrganizationSeatPreview, SeatAssignmentWork, type SeatAssignmentRequest, type SeatAssignmentTarget } from "@openorc/protocol";

export type { SeatAssignmentTarget } from "@openorc/protocol";
export interface SeatAssignmentState {
  state: "draft" | "preview" | "submitting" | "pending" | "complete" | "failed";
  target: SeatAssignmentTarget | null;
  preview: OrganizationSeatPreview | null;
  work: SeatAssignmentWork | null;
  reviewing: boolean;
  error: string | null;
}
export interface SeatAssignmentDeps {
  current(): boolean;
  now(): number;
  id(): string;
  preview(target: SeatAssignmentTarget): Promise<OrganizationSeatPreview>;
  send(request: SeatAssignmentRequest): Promise<SeatAssignmentWork>;
  read(id: string): Promise<SeatAssignmentWork | null>;
}

export class SeatAssignment {
  #snapshot: SeatAssignmentState = empty();
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #running: Promise<void> | null = null;
  #expiry: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  constructor(private readonly deps: SeatAssignmentDeps) {}
  getSnapshot = (): SeatAssignmentState => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  select(target: SeatAssignmentTarget | null): void {
    if (!this.#canReview()) return;
    ++this.#generation;
    this.#clearExpiry();
    this.#publish({ ...empty(), target: structuredClone(target) });
  }

  async review(): Promise<void> {
    if (!this.#canReview() || !this.#snapshot.target) return;
    const target = structuredClone(this.#snapshot.target);
    const generation = ++this.#generation;
    this.#clearExpiry();
    this.#publish({ state: "draft", reviewing: true, preview: null, work: null, error: null });
    try {
      if (!this.#live(generation)) return;
      const preview = OrganizationSeatPreview.parse(await this.deps.preview(target));
      if (!this.#live(generation)) return;
      if (preview.seat.id !== target.seatId || (preview.to?.memberId ?? null) !== target.memberId) throw new Error("That seat has changed. Review the change again.");
      if (preview.expiresAt <= this.deps.now()) throw new Error("That seat has changed. Review the change again.");
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
    const request = { seatId: preview.seat.id, body: { id: this.deps.id(), previewToken: preview.token } };
    return this.#run({ request, operation: null, error: null }, true);
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

  resume(input: SeatAssignmentWork, preview?: OrganizationSeatPreview): void {
    if (!this.#current() || this.#running) return;
    const work = SeatAssignmentWork.parse(input);
    const previous = this.#snapshot.work;
    if (previous && previous.request.body.id !== work.request.body.id) return;
    if (previous?.operation?.state === "complete" && work.operation?.state !== "complete") return;
    this.#clearExpiry();
    ++this.#generation;
    const remembered = preview?.token === work.request.body.previewToken && preview.seat.id === work.request.seatId ? preview : null;
    this.#snapshot = { ...empty(), preview: remembered, target: remembered ? { seatId: remembered.seat.id, memberId: remembered.to?.memberId ?? null } : null };
    this.#accept(work);
  }

  #run(work: SeatAssignmentWork, send: boolean): Promise<void> {
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

  #receive(previous: SeatAssignmentWork, result: SeatAssignmentWork): void {
    const parsed = SeatAssignmentWork.safeParse(result);
    if (!parsed.success || JSON.stringify(parsed.data.request) !== JSON.stringify(previous.request)) {
      this.#accept({ ...previous, error: "The seat change could not be confirmed. Try again." });
      return;
    }
    if (previous.operation?.state === "complete" && parsed.data.operation?.state !== "complete") return;
    this.#accept(parsed.data);
  }

  #accept(work: SeatAssignmentWork): void {
    const state = work.operation?.state ?? "pending";
    this.#publish({ state, work, reviewing: false, error: work.error ?? work.operation?.message ?? null });
  }

  #expire(): void {
    const { state, preview } = this.#snapshot;
    if (state !== "preview" || !preview || preview.expiresAt > this.deps.now()) return;
    this.#clearExpiry();
    this.#publish({ state: "draft", preview: null, error: "That seat has changed. Review the change again." });
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
  #publish(update: Partial<SeatAssignmentState>): void {
    this.#snapshot = { ...this.#snapshot, ...update };
    this.#listeners.forEach((listener) => listener());
  }
}

const empty = (): SeatAssignmentState => ({ state: "draft", target: null, preview: null, work: null, reviewing: false, error: null });
const words = (error: unknown) => (error instanceof Error ? error.message : "The seat change could not be confirmed. Try again.");
