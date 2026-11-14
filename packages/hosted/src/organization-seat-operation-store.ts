import { SeatAssignmentRequest, SeatAssignmentWork } from "@openorc/protocol";
import { z } from "zod";
import { organizationBillingKey, type OrganizationBillingScope, type OrganizationBillingStorage } from "./organization-billing-store.js";

export const seatAssignmentRequest = SeatAssignmentRequest;
export type { SeatAssignmentRequest, SeatAssignmentWork } from "@openorc/protocol";
const records = z.array(
  z
    .object({
      scope: z.object({ origin: z.string(), userId: z.string(), spaceId: z.string() }).strict(),
      work: SeatAssignmentWork,
    })
    .strict(),
);

/** The durable request contains no inventory or person details. Unreadable history blocks another mutation. */
export class SeatOperationStore {
  readonly #scope: OrganizationBillingScope;
  constructor(
    scope: OrganizationBillingScope,
    private readonly storage: OrganizationBillingStorage,
  ) {
    this.#scope = structuredClone(scope);
  }
  list(): SeatAssignmentWork[] {
    const key = organizationBillingKey(this.#scope);
    return this.#read()
      .filter((row) => organizationBillingKey(row.scope) === key)
      .map((row) => row.work);
  }
  save(value: SeatAssignmentWork): SeatAssignmentWork {
    const parsed = SeatAssignmentWork.parse(value);
    const key = organizationBillingKey(this.#scope);
    const kept = this.#read().filter((row) => organizationBillingKey(row.scope) !== key || row.work.request.body.id !== parsed.request.body.id);
    this.storage.save(JSON.stringify([...kept, { scope: this.#scope, work: parsed }]));
    return parsed;
  }
  #read() {
    const value = this.storage.load();
    if (value === null) return [];
    try {
      return records.parse(JSON.parse(value));
    } catch {
      throw new Error("Saved seat changes could not be read. Restart OpenOrc before making another change.");
    }
  }
}
