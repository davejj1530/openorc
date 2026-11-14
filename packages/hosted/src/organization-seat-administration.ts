import type { OrganizationSeatPreview, OrganizationSeatReply, SeatAssignmentRequest, SeatAssignmentTarget, SeatAssignmentWork } from "@openorc/protocol";
import { OrganizationSeatAssignment, type SeatAssignmentDeps } from "./organization-seat-assignment.js";
import { organizationBillingKey } from "./organization-billing-store.js";
import { Refused } from "./session.js";

interface Entry {
  lease: SeatAssignmentDeps;
  assignment: OrganizationSeatAssignment;
}

/** Shares billing authority while keeping its durable operation journal separate from checkout attempts. */
export class OrganizationSeatAdministration {
  readonly #entries = new Map<string, Entry>();
  constructor(private readonly resolve: (spaceId: string) => SeatAssignmentDeps) {}

  preview(spaceId: string, target: SeatAssignmentTarget): Promise<OrganizationSeatReply<OrganizationSeatPreview>> {
    return this.#call(spaceId, (assignment) => assignment.preview(target));
  }
  assign(spaceId: string, request: SeatAssignmentRequest): Promise<OrganizationSeatReply<SeatAssignmentWork>> {
    return this.#call(spaceId, (assignment) => assignment.send(request));
  }
  operation(spaceId: string, id: string): Promise<OrganizationSeatReply<SeatAssignmentWork | null>> {
    return this.#call(spaceId, (assignment) => assignment.read(id));
  }
  list(spaceId: string): SeatAssignmentWork[] {
    return this.#get(spaceId).assignment.list();
  }
  async reconcile(): Promise<void> {
    this.purge();
    await Promise.allSettled([...this.#entries.values()].map((entry) => entry.assignment.reconcile()));
  }
  purge(): void {
    for (const [key, entry] of this.#entries)
      if (!entry.lease.current()) {
        this.#entries.delete(key);
        entry.assignment.close();
      }
  }
  close(): void {
    for (const entry of this.#entries.values()) entry.assignment.close();
    this.#entries.clear();
  }

  #get(spaceId: string): Entry {
    this.purge();
    const lease = this.resolve(spaceId);
    const key = organizationBillingKey(lease.scope);
    const existing = this.#entries.get(key);
    if (existing) return existing;
    const entry = { lease, assignment: new OrganizationSeatAssignment(lease) };
    this.#entries.set(key, entry);
    return entry;
  }
  async #call<T>(spaceId: string, work: (assignment: OrganizationSeatAssignment) => Promise<T>): Promise<OrganizationSeatReply<T>> {
    let entry: Entry | undefined;
    try {
      entry = this.#get(spaceId);
      const value = await work(entry.assignment);
      if (!entry.lease.current()) return { state: "denied", message: "Your organization access changed. Try again." };
      return { state: "ready", value };
    } catch (error) {
      if ((!entry && error instanceof Refused) || (entry && !entry.lease.current()))
        return { state: "denied", message: error instanceof Error ? error.message : "Your organization access changed. Try again." };
      throw error;
    }
  }
}
