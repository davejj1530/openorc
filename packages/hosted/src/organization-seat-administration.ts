import type {
  OrganizationSeatPreview,
  OrganizationSeatReply,
  SeatAssignmentRequest,
  SeatAssignmentTarget,
  SeatAssignmentWork,
  SeatQuantityPreview,
  SeatQuantityRequest,
  SeatQuantityWork,
} from "@openorc/protocol";
import { OrganizationSeatAssignment, type SeatAssignmentDeps } from "./organization-seat-assignment.js";
import { OrganizationSeatQuantity } from "./organization-seat-quantity.js";
import { organizationBillingKey } from "./organization-billing-store.js";
import { Refused } from "./session.js";

/** An admin's standing in one organization, with the store each kind of seat change journals to. */
export interface SeatLease extends SeatAssignmentDeps {
  /** Null where this host keeps no journal for changes of the number of seats: they are then unavailable. */
  quantityStorage: SeatAssignmentDeps["storage"] | null;
}
interface Entry {
  lease: SeatLease;
  assignment: OrganizationSeatAssignment;
  quantity: OrganizationSeatQuantity | null;
}

/** Shares billing authority while keeping its durable operation journal separate from checkout attempts. */
export class OrganizationSeatAdministration {
  readonly #entries = new Map<string, Entry>();
  constructor(private readonly resolve: (spaceId: string) => SeatLease) {}

  preview(spaceId: string, target: SeatAssignmentTarget): Promise<OrganizationSeatReply<OrganizationSeatPreview>> {
    return this.#call(spaceId, (entry) => entry.assignment.preview(target));
  }
  assign(spaceId: string, request: SeatAssignmentRequest): Promise<OrganizationSeatReply<SeatAssignmentWork>> {
    return this.#call(spaceId, (entry) => entry.assignment.send(request));
  }
  operation(spaceId: string, id: string): Promise<OrganizationSeatReply<SeatAssignmentWork | null>> {
    return this.#call(spaceId, (entry) => entry.assignment.read(id));
  }
  list(spaceId: string): SeatAssignmentWork[] {
    return this.#get(spaceId).assignment.list();
  }
  previewQuantity(spaceId: string, seats: number): Promise<OrganizationSeatReply<SeatQuantityPreview>> {
    return this.#call(spaceId, (entry) => counted(entry).preview(seats));
  }
  setQuantity(spaceId: string, request: SeatQuantityRequest): Promise<OrganizationSeatReply<SeatQuantityWork>> {
    return this.#call(spaceId, (entry) => counted(entry).send(request));
  }
  quantityOperation(spaceId: string, id: string): Promise<OrganizationSeatReply<SeatQuantityWork | null>> {
    return this.#call(spaceId, (entry) => counted(entry).read(id));
  }
  /** The change of the number of seats still to show for this organization, if any. */
  quantity(spaceId: string): SeatQuantityWork[] {
    return this.#get(spaceId).quantity?.open() ?? [];
  }
  async reconcile(): Promise<void> {
    this.purge();
    await Promise.allSettled([...this.#entries.values()].flatMap((entry) => [entry.assignment.reconcile(), entry.quantity?.reconcile()]));
  }
  purge(): void {
    for (const [key, entry] of this.#entries)
      if (!entry.lease.current()) {
        this.#entries.delete(key);
        close(entry);
      }
  }
  close(): void {
    for (const entry of this.#entries.values()) close(entry);
    this.#entries.clear();
  }

  #get(spaceId: string): Entry {
    this.purge();
    const lease = this.resolve(spaceId);
    const key = organizationBillingKey(lease.scope);
    const existing = this.#entries.get(key);
    if (existing) return existing;
    const quantity = lease.quantityStorage ? new OrganizationSeatQuantity({ ...lease, storage: lease.quantityStorage }) : null;
    const entry = { lease, assignment: new OrganizationSeatAssignment(lease), quantity };
    this.#entries.set(key, entry);
    return entry;
  }
  async #call<T>(spaceId: string, work: (entry: Entry) => Promise<T>): Promise<OrganizationSeatReply<T>> {
    let entry: Entry | undefined;
    try {
      entry = this.#get(spaceId);
      const value = await work(entry);
      if (!entry.lease.current()) return { state: "denied", message: "Your organization access changed. Try again." };
      return { state: "ready", value };
    } catch (error) {
      if ((!entry && error instanceof Refused) || (entry && !entry.lease.current()))
        return { state: "denied", message: error instanceof Error ? error.message : "Your organization access changed. Try again." };
      throw error;
    }
  }
}

function close(entry: Entry): void {
  entry.assignment.close();
  entry.quantity?.close();
}

function counted(entry: Entry): OrganizationSeatQuantity {
  if (!entry.quantity) throw new Error("Seat changes aren't available here.");
  return entry.quantity;
}
