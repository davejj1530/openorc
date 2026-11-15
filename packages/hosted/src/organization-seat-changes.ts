import type { SeatOperation } from "@openorc/protocol";
import type { OrganizationBillingScope, OrganizationBillingStorage } from "./organization-billing-store.js";
import type { SeatChange, SeatWork } from "./organization-seat-operation-store.js";
import { OrganizationSeatOperations } from "./organization-seat-operations.js";
import { Refused } from "./session.js";
import type { Route } from "./wire.js";

export interface SeatChangeDeps {
  scope: OrganizationBillingScope;
  storage: OrganizationBillingStorage;
  current(): boolean;
  now(): number;
  request<T>(route: Route<T>, body?: unknown): Promise<T>;
  refresh(): Promise<void>;
  changed(): void;
}

/**
 * The journal of one kind of seat change for one organization and admin, with its quiet reads: while a change is not
 * settled, or its following read is owed, it is read again every ten seconds. Nothing here ever writes by itself.
 */
export class SeatChanges<R extends { body: { id: string } }> {
  readonly #operations: OrganizationSeatOperations<R>;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  constructor(
    private readonly deps: SeatChangeDeps,
    change: SeatChange<R>,
    routes: { submit(request: R): Route<SeatOperation>; read(id: string): Route<SeatOperation> },
  ) {
    this.#operations = new OrganizationSeatOperations<R>({
      scope: deps.scope,
      storage: deps.storage,
      change,
      current: () => this.current(),
      submit: (request) => this.request(routes.submit(request), request.body),
      read: (id) => this.request(routes.read(id)),
      refresh: deps.refresh,
      changed: () => {
        this.deps.changed();
        this.#schedule();
      },
    });
    this.#schedule();
  }

  send(request: R): Promise<SeatWork<R>> {
    return this.#operations.send(request);
  }
  read(id: string): Promise<SeatWork<R> | null> {
    return this.#operations.read(id);
  }
  list(): SeatWork<R>[] {
    return this.#operations.list();
  }
  reconcile(): Promise<void> {
    return this.#operations.reconcile();
  }
  close(): void {
    this.#closed = true;
    this.#clearTimer();
    this.#operations.close();
  }

  /** A request bound to this admin's authority before and after it. */
  async request<T>(route: Route<T>, body?: unknown): Promise<T> {
    this.#assert();
    const answer = await this.deps.request(route, body);
    this.#assert();
    return answer;
  }
  current(): boolean {
    return !this.#closed && this.deps.current();
  }

  #schedule(): void {
    if (!this.current() || !this.list().some(needsRead)) return this.#clearTimer();
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.current()) return;
      void this.reconcile()
        .catch(() => undefined)
        .finally(() => this.#schedule());
    }, 10_000);
  }
  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
  #assert(): void {
    if (!this.current()) throw new Refused("Your organization access changed. Try again.");
  }
}

const needsRead = (work: SeatWork<unknown>) => work.operation === null || work.operation.state === "pending" || (work.operation.state === "complete" && work.error !== null);
