import {
  organizationBillingRpcParams,
  type OrganizationBilling as Billing,
  type OrganizationBillingOffers,
  type OrganizationBillingPage,
  type OrganizationBillingStatus,
  type OrganizationStorageRead,
  type SeatAssignmentWork,
} from "@openorc/protocol";
import type { HostedDeps, HostedSpaces } from "./index.js";
import { OrganizationBillingPayment } from "./organization-billing-payment.js";
import { OrganizationBillingStore, organizationBillingKey, type OrganizationBillingScope, type OrganizationBillingStorage } from "./organization-billing-store.js";
import { ORGANIZATION_BILLING_ROUTES as routes, toOrganizationBilling } from "./organization-billing-wire.js";
import { Refused, type Session } from "./session.js";
import { organizationStorageRoute } from "./organization-storage.js";
import { OrganizationSeatAdministration } from "./organization-seat-administration.js";
import type { SeatAssignmentDeps } from "./organization-seat-assignment.js";
import { SOCKET, wireTopics, type Route } from "./wire.js";

interface Dependencies extends Pick<HostedDeps, "browser" | "now" | "push" | "server"> {
  session: Pick<Session, "state" | "generation" | "in" | "onChange" | "onSocket">;
  spaces: Pick<HostedSpaces, "status" | "refresh">;
  storage: OrganizationBillingStorage;
  operations?: OrganizationBillingStorage;
}
interface Entry {
  scope: OrganizationBillingScope;
  generation: number;
  billing: Billing | null;
  exposed: boolean;
  error: string | null;
  reading: Promise<void> | null;
  payment: OrganizationBillingPayment;
}

/** Explicit-space admin reads and durable payment intents. No renderer receives a URL or bearer token. */
export class OrganizationBilling {
  readonly seats: OrganizationSeatAdministration;
  readonly #store: OrganizationBillingStore;
  readonly #entries = new Map<string, Entry>();
  readonly #origin: string;
  #closed = false;

  constructor(private readonly deps: Dependencies) {
    this.#store = new OrganizationBillingStore(deps.storage);
    this.#origin = new URL(deps.server).origin;
    this.seats = new OrganizationSeatAdministration((spaceId) => this.#seatLease(spaceId));
    deps.session.onChange((change) => {
      this.#purge();
      if (change === "connected") void this.awoke();
    });
    deps.session.onSocket(SOCKET.changed, (body) => {
      const parsed = wireTopics.safeParse(body);
      if (!parsed.success || !parsed.data.topics.some((topic) => ["billing", "members", "invitations", "spaces"].includes(topic))) return;
      void this.awoke();
    });
  }

  async get(spaceId: string): Promise<OrganizationBillingStatus> {
    const entry = this.#entry(spaceId);
    await this.#read(entry);
    this.#assert(entry);
    return this.#status(entry);
  }

  /** RPC errors carry only words. Authority refusals must clear the renderer's private snapshot explicitly. */
  async read(spaceId: string): Promise<OrganizationBillingStatus> {
    try {
      return await this.get(spaceId);
    } catch (error) {
      if (error instanceof Refused) return { billing: null, payment: null, error: error.message };
      throw error;
    }
  }

  async offers(spaceId: string, seats: number): Promise<OrganizationBillingOffers> {
    organizationBillingRpcParams["organization.billing.offers"].parse({ spaceId, seats });
    const entry = this.#entry(spaceId);
    const offers = await this.#request(entry, routes.offers(seats));
    this.#assert(entry);
    if (offers.offers.some((offer) => offer.seats !== seats)) throw new Error("The seat prices changed. Try again.");
    entry.exposed = true;
    return offers;
  }

  async storage(spaceId: string): Promise<OrganizationStorageRead> {
    try {
      const entry = this.#entry(spaceId);
      const storage = await this.#request(entry, organizationStorageRoute);
      this.#assert(entry);
      entry.exposed = true;
      return { storage, error: null };
    } catch (error) {
      return { storage: null, error: error instanceof Error ? error.message : "Storage could not be read." };
    }
  }

  async open(spaceId: string, target: OrganizationBillingPage): Promise<OrganizationBillingStatus> {
    organizationBillingRpcParams["organization.billing.open"].parse({ spaceId, target });
    const entry = this.#entry(spaceId);
    await entry.payment.open(target);
    this.#assert(entry);
    return this.#status(entry);
  }

  leave(spaceId: string): OrganizationBillingStatus {
    const entry = this.#entry(spaceId);
    entry.payment.leave();
    return this.#status(entry);
  }

  /** Reconnect and focus only reread; even an unresolved checkout needs another press to retry. */
  async awoke(): Promise<void> {
    if (this.#closed || this.#entries.size === 0) return;
    await this.deps.spaces.refresh();
    this.#purge();
    await Promise.allSettled([...this.#entries.values()].map((entry) => this.#refresh(entry)));
    await this.seats.reconcile();
  }

  close(): void {
    this.#closed = true;
    this.seats.close();
    for (const entry of this.#entries.values()) entry.payment.close();
    this.#entries.clear();
  }

  #scope(spaceId: string): OrganizationBillingScope {
    const status = this.deps.spaces.status();
    if (status.state !== "ready" || !this.deps.session.state.signedIn || this.#closed) throw new Refused("Sign in to OpenOrc first.");
    const space = status.spaces.find((space) => space.id === spaceId);
    if (!space) throw new Refused("You aren't a member of this organization.", 403);
    if (space.kind === "personal") throw new Refused("Your personal space has no organization seats. Manage your own Pro in Account.", 409);
    if (space.role !== "admin") throw new Refused("Only an admin can do that.", 403);
    return { origin: this.#origin, userId: status.userId, spaceId };
  }

  #entry(spaceId: string): Entry {
    this.#purge();
    const scope = this.#scope(spaceId);
    const key = organizationBillingKey(scope);
    const existing = this.#entries.get(key);
    if (existing) return existing;
    const generation = this.deps.session.generation;
    const entry: Entry = {
      scope,
      generation,
      billing: null,
      exposed: false,
      error: null,
      reading: null,
      payment: new OrganizationBillingPayment({
        now: this.deps.now,
        browser: this.deps.browser,
        current: () => this.#current(entry),
        billing: () => entry.billing,
        load: () => this.#store.load(scope),
        save: (record) => this.#store.save(scope, record),
        link: (target) => this.#request(entry, target.page === "checkout" ? routes.checkout : routes.portal, target.page === "checkout" ? { plan: target.plan, seats: target.seats } : undefined),
        reread: () => this.#refresh(entry),
        changed: () => {
          if (this.#current(entry)) this.#tell(spaceId);
        },
      }),
    };
    this.#entries.set(key, entry);
    return entry;
  }

  #status(entry: Entry): OrganizationBillingStatus {
    entry.exposed = true;
    let assignments: SeatAssignmentWork[] = [];
    let error = entry.error;
    try {
      if (this.deps.operations) assignments = this.seats.list(entry.scope.spaceId).filter((work) => work.operation?.state !== "complete" || work.error !== null);
    } catch (failure) {
      error ??= failure instanceof Error ? failure.message : "Saved seat changes could not be read.";
    }
    return { billing: entry.billing, payment: entry.payment.work, error, ...(assignments.length > 0 && { assignments }) };
  }

  #seatLease(spaceId: string): SeatAssignmentDeps {
    const entry = this.#entry(spaceId);
    if (!this.deps.operations) throw new Error("Seat changes aren't available here.");
    entry.exposed = true;
    return {
      scope: entry.scope,
      storage: this.deps.operations,
      current: () => this.#current(entry),
      now: this.deps.now,
      request: (route, body) => this.#seatRequest(entry, route, body),
      refresh: async () => {
        await this.#read(entry);
        this.#assert(entry);
        if (entry.error) throw new Error(entry.error);
        this.deps.push({ type: "invalidate", keys: [`organization-billing:${spaceId}`, `people:${spaceId}`, "account"] });
      },
      changed: () => {
        if (this.#current(entry)) this.#tell(spaceId);
      },
    };
  }

  async #seatRequest<T>(entry: Entry, route: Route<T>, body?: unknown): Promise<T> {
    try {
      return await this.deps.session.in(entry.scope.spaceId).request(route, body);
    } catch (error) {
      // An unknown operation is a replay probe, not evidence that organization membership ended.
      if (error instanceof Refused && [401, 403].includes(error.status ?? 0)) this.#drop(entry);
      throw error;
    }
  }

  async #request<T>(entry: Entry, route: Route<T>, body?: unknown): Promise<T> {
    try {
      return await this.deps.session.in(entry.scope.spaceId).request(route, body);
    } catch (error) {
      if (error instanceof Refused && ([401, 403].includes(error.status ?? 0) || (error.status === 404 && route !== organizationStorageRoute))) this.#drop(entry);
      throw error;
    }
  }

  #read(entry: Entry): Promise<void> {
    if (entry.reading) return entry.reading;
    const reading = this.#readOnce(entry).finally(() => {
      if (entry.reading === reading) entry.reading = null;
    });
    entry.reading = reading;
    return reading;
  }

  async #refresh(entry: Entry): Promise<void> {
    await this.#read(entry);
    if (this.#current(entry)) this.#tell(entry.scope.spaceId);
  }

  async #readOnce(entry: Entry): Promise<void> {
    try {
      const answer = await this.deps.session.in(entry.scope.spaceId).request(routes.get);
      this.#assert(entry);
      if (answer.organization.id !== entry.scope.spaceId) throw new Error("The organization changed. Try again.");
      entry.billing = toOrganizationBilling(answer);
      entry.error = null;
      entry.payment.heard(entry.billing);
    } catch (error) {
      this.#assert(entry);
      if (error instanceof Refused && [401, 403, 404].includes(error.status ?? 0)) {
        this.#drop(entry);
        throw error;
      }
      entry.error = error instanceof Error ? error.message : "The seats could not be read.";
    }
  }

  #current(entry: Entry): boolean {
    if (this.#closed || this.#entries.get(organizationBillingKey(entry.scope)) !== entry || this.deps.session.generation !== entry.generation || !this.deps.session.state.signedIn) return false;
    const status = this.deps.spaces.status();
    return (
      status.state === "ready" && status.userId === entry.scope.userId && status.spaces.some((space) => space.id === entry.scope.spaceId && space.kind === "organization" && space.role === "admin")
    );
  }

  #assert(entry: Entry): void {
    if (!this.#current(entry)) throw new Refused("Your organization access changed. Try again.");
  }

  #purge(): void {
    for (const entry of this.#entries.values()) if (!this.#current(entry)) this.#drop(entry);
  }

  #drop(entry: Entry): void {
    this.#entries.delete(organizationBillingKey(entry.scope));
    this.seats.purge();
    entry.billing = null;
    entry.payment.close();
    if (entry.exposed) this.#tell(entry.scope.spaceId);
  }

  #tell(spaceId: string): void {
    if (!this.#closed) this.deps.push({ type: "invalidate", keys: [`organization-billing:${spaceId}`] });
  }
}
