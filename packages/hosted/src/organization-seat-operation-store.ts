import { SeatAssignmentRequest, SeatAssignmentWork, SeatQuantityRequest, SeatQuantityWork, type SeatOperation } from "@openorc/protocol";
import { z } from "zod";
import { organizationBillingKey, type OrganizationBillingScope, type OrganizationBillingStorage } from "./organization-billing-store.js";

export const seatAssignmentRequest = SeatAssignmentRequest;
export type { SeatAssignmentRequest, SeatAssignmentWork } from "@openorc/protocol";

/** A journaled change: the exact request as sent, and what became of it. */
export interface SeatWork<R> {
  request: R;
  operation: SeatOperation | null;
  error: string | null;
}
/** One kind of seat change the journal keeps: moving a seat, or changing how many there are. */
export interface SeatChange<R extends { body: { id: string } }> {
  kind: SeatOperation["kind"];
  request: z.ZodType<R>;
  work: z.ZodType<SeatWork<R>>;
  /** What only one unsettled change may touch at a time. */
  subject(request: R): string;
  /** The server's words while a change of this subject is still being settled. */
  busy: string;
}
export const SEAT_ASSIGNMENT: SeatChange<SeatAssignmentRequest> = {
  kind: "assignment",
  request: SeatAssignmentRequest,
  work: SeatAssignmentWork,
  subject: (request) => request.seatId,
  busy: "Moving the seat.",
};
export const SEAT_QUANTITY: SeatChange<SeatQuantityRequest> = { kind: "quantity", request: SeatQuantityRequest, work: SeatQuantityWork, subject: () => "quantity", busy: "Updating seats." };

const scope = z.object({ origin: z.string(), userId: z.string(), spaceId: z.string() }).strict();

/** The durable request contains no inventory or person details. Unreadable history blocks another mutation. */
export class SeatOperationStore<R extends { body: { id: string } }> {
  readonly #scope: OrganizationBillingScope;
  readonly #records: z.ZodType<{ scope: OrganizationBillingScope; work: SeatWork<R> }[]>;
  constructor(
    scope_: OrganizationBillingScope,
    private readonly storage: OrganizationBillingStorage,
    private readonly change: SeatChange<R>,
  ) {
    this.#scope = structuredClone(scope_);
    this.#records = z.array(z.object({ scope, work: change.work }).strict());
  }
  list(): SeatWork<R>[] {
    const key = organizationBillingKey(this.#scope);
    return this.#read()
      .filter((row) => organizationBillingKey(row.scope) === key)
      .map((row) => row.work);
  }
  save(value: SeatWork<R>): SeatWork<R> {
    const parsed = this.change.work.parse(value);
    const key = organizationBillingKey(this.#scope);
    const kept = this.#read().filter((row) => organizationBillingKey(row.scope) !== key || row.work.request.body.id !== parsed.request.body.id);
    this.storage.save(JSON.stringify([...kept, { scope: this.#scope, work: parsed }]));
    return parsed;
  }
  #read() {
    const value = this.storage.load();
    if (value === null) return [];
    try {
      return this.#records.parse(JSON.parse(value));
    } catch {
      throw new Error("Saved seat changes could not be read. Restart OpenOrc before making another change.");
    }
  }
}
