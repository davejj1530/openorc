import { SeatAssignmentTarget, type OrganizationSeatPreview, type SeatAssignmentRequest, type SeatAssignmentWork } from "@openorc/protocol";
import type { OrganizationBillingScope, OrganizationBillingStorage } from "./organization-billing-store.js";
import { SEAT_ASSIGNMENT_ROUTES as routes, toSeatPreview } from "./organization-seat-assignment-wire.js";
import { OrganizationSeatOperations } from "./organization-seat-operations.js";
import { Refused } from "./session.js";
import type { Route } from "./wire.js";

export interface SeatAssignmentDeps {
  scope: OrganizationBillingScope;
  storage: OrganizationBillingStorage;
  current(): boolean;
  now(): number;
  request<T>(route: Route<T>, body?: unknown): Promise<T>;
  refresh(): Promise<void>;
  changed(): void;
}

export class OrganizationSeatAssignment {
  readonly #operations: OrganizationSeatOperations;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  constructor(private readonly deps: SeatAssignmentDeps) {
    this.#operations = new OrganizationSeatOperations({
      scope: deps.scope,
      storage: deps.storage,
      current: () => this.#current(),
      submit: (request) => this.#request(routes.assign(request.seatId), request.body),
      read: (id) => this.#request(routes.operation(id)),
      refresh: deps.refresh,
      changed: () => {
        this.deps.changed();
        this.#schedule();
      },
    });
    this.#schedule();
  }

  async preview(input: SeatAssignmentTarget): Promise<OrganizationSeatPreview> {
    const target = SeatAssignmentTarget.parse(input);
    const preview = toSeatPreview(await this.#request(routes.preview(target.seatId), { memberId: target.memberId }));
    if (preview.seat.id !== target.seatId || (preview.to?.memberId ?? null) !== target.memberId || preview.expiresAt <= this.deps.now()) {
      throw new Refused("That seat has changed. Review the change again.", 409);
    }
    return preview;
  }

  send(request: SeatAssignmentRequest): Promise<SeatAssignmentWork> {
    return this.#operations.send(request);
  }
  read(id: string): Promise<SeatAssignmentWork | null> {
    return this.#operations.read(id);
  }
  list(): SeatAssignmentWork[] {
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

  async #request<T>(route: Route<T>, body?: unknown): Promise<T> {
    this.#assert();
    const answer = await this.deps.request(route, body);
    this.#assert();
    return answer;
  }

  #schedule(): void {
    if (!this.#current() || !this.list().some(needsRead)) return this.#clearTimer();
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#current()) return;
      void this.reconcile()
        .catch(() => undefined)
        .finally(() => this.#schedule());
    }, 10_000);
  }
  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
  #current(): boolean {
    return !this.#closed && this.deps.current();
  }
  #assert(): void {
    if (!this.#current()) throw new Refused("Your organization access changed. Try again.");
  }
}

const needsRead = (work: SeatAssignmentWork) => work.operation === null || work.operation.state === "pending" || (work.operation.state === "complete" && work.error !== null);
