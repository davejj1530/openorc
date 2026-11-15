import { SeatOperation } from "@openorc/protocol";
import type { OrganizationBillingScope, OrganizationBillingStorage } from "./organization-billing-store.js";
import { SEAT_ASSIGNMENT, SeatOperationStore, type SeatAssignmentRequest, type SeatChange, type SeatWork } from "./organization-seat-operation-store.js";
import { Refused } from "./session.js";

export type { SeatAssignmentRequest, SeatAssignmentWork, SeatWork } from "./organization-seat-operation-store.js";
type Request = { body: { id: string } };
export interface SeatOperationDeps<R extends Request = SeatAssignmentRequest> {
  scope: OrganizationBillingScope;
  storage: OrganizationBillingStorage;
  /** Which kind of change this journal keeps; a seat's assignment when not said. */
  change?: SeatChange<R>;
  current(): boolean;
  submit(request: R): Promise<SeatOperation>;
  read(id: string): Promise<SeatOperation>;
  refresh(): Promise<void>;
  changed(): void;
}

/** One journaled change per subject. Reconciliation reads first; only an explicit retry can repeat an unknown write. */
export class OrganizationSeatOperations<R extends Request = SeatAssignmentRequest> {
  readonly #change: SeatChange<R>;
  readonly #store: SeatOperationStore<R>;
  readonly #running = new Map<string, Promise<SeatWork<R>>>();
  #closed = false;
  constructor(private readonly deps: SeatOperationDeps<R>) {
    this.#change = deps.change ?? (SEAT_ASSIGNMENT as unknown as SeatChange<R>);
    this.#store = new SeatOperationStore(deps.scope, deps.storage, this.#change);
  }

  list(): SeatWork<R>[] {
    return this.#current() ? this.#store.list() : [];
  }

  async send(input: R): Promise<SeatWork<R>> {
    this.#assert();
    const request = this.#change.request.parse(input);
    const existing = this.#store.list().find((work) => work.request.body.id === request.body.id);
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) throw new Error("That change was already sent with different details. Read the seats again.");
      return this.retry(request.body.id);
    }
    const subject = this.#change.subject(request);
    if (this.#store.list().some((work) => this.#change.subject(work.request) === subject && pending(work))) throw new Error(this.#change.busy);
    const work = this.#store.save({ request, operation: null, error: null });
    return this.#run(work, () => {
      this.deps.changed();
      return this.#submit(work);
    });
  }

  async retry(id: string): Promise<SeatWork<R>> {
    const work = this.#find(id);
    return this.#run(work, () => this.#read(work, true));
  }

  async read(id: string): Promise<SeatWork<R> | null> {
    this.#assert();
    const work = this.#store.list().find((work) => work.request.body.id === id);
    return work ? this.#run(work, () => this.#read(work, false)) : null;
  }

  async reconcile(): Promise<void> {
    this.#assert();
    const work = this.#store.list().filter((work) => pending(work) || (work.operation?.state === "complete" && work.error !== null));
    await Promise.allSettled(work.map((work) => this.#run(work, () => this.#read(work, false))));
  }

  close(): void {
    this.#closed = true;
    this.deps.changed();
  }

  #run(work: SeatWork<R>, run: () => Promise<SeatWork<R>>): Promise<SeatWork<R>> {
    const id = work.request.body.id;
    const existing = this.#running.get(id);
    if (existing) return existing;
    // Claim the operation before a notification can synchronously request reconciliation.
    const running = Promise.resolve()
      .then(run)
      .finally(() => {
        if (this.#running.get(id) === running) this.#running.delete(id);
      });
    this.#running.set(id, running);
    return running;
  }

  async #submit(work: SeatWork<R>): Promise<SeatWork<R>> {
    this.#assert();
    let answer: SeatOperation;
    try {
      answer = await this.deps.submit(structuredClone(work.request));
    } catch (error) {
      this.#assert();
      const operation = terminal(error) ? { id: work.request.body.id, kind: this.#change.kind, state: "failed" as const, message: words(error) } : work.operation;
      return this.#save({ ...work, operation, error: words(error) });
    }
    return this.#receive(work, answer);
  }

  async #read(work: SeatWork<R>, repeatUnknown: boolean): Promise<SeatWork<R>> {
    this.#assert();
    if (work.operation?.state === "complete") return this.#refresh(work);
    if (work.operation?.state === "failed") return work;
    let answer: SeatOperation;
    try {
      answer = await this.deps.read(work.request.body.id);
    } catch (error) {
      this.#assert();
      if (repeatUnknown && work.operation === null && error instanceof Refused && error.status === 404) return this.#submit(work);
      return this.#save({ ...work, error: words(error) });
    }
    return this.#receive(work, answer);
  }

  async #receive(work: SeatWork<R>, answer: SeatOperation): Promise<SeatWork<R>> {
    this.#assert();
    const parsed = SeatOperation.safeParse(answer);
    if (!parsed.success || parsed.data.id !== work.request.body.id || parsed.data.kind !== this.#change.kind)
      return this.#save({ ...work, error: "The seat change could not be confirmed. Try again." });
    const operation = parsed.data;
    const updated = this.#save({ ...work, operation, error: null });
    return operation.state === "complete" ? this.#refresh(updated) : updated;
  }

  async #refresh(work: SeatWork<R>): Promise<SeatWork<R>> {
    try {
      await this.deps.refresh();
      return this.#save({ ...work, error: null });
    } catch (error) {
      this.#assert();
      return this.#save({ ...work, error: words(error) });
    }
  }

  #find(id: string): SeatWork<R> {
    this.#assert();
    const work = this.#store.list().find((work) => work.request.body.id === id);
    if (!work) throw new Error("The saved seat change could not be found. Read the seats again.");
    return work;
  }

  #save(work: SeatWork<R>): SeatWork<R> {
    this.#assert();
    const saved = this.#store.save(work);
    this.deps.changed();
    return saved;
  }

  #current(): boolean {
    return !this.#closed && this.deps.current();
  }
  #assert(): void {
    if (!this.#current()) throw new Error("Your organization access changed. Try again.");
  }
}

const pending = (work: SeatWork<unknown>) => work.operation === null || work.operation.state === "pending";
const words = (error: unknown) => (error instanceof Error ? error.message : "The seat change could not be confirmed. Try again.");
const terminal = (error: unknown) => error instanceof Refused && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408;
