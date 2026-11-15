import { seatQuantity, type SeatQuantityPreview, type SeatQuantityRequest, type SeatQuantityWork } from "@openorc/protocol";
import { SeatChanges, type SeatChangeDeps } from "./organization-seat-changes.js";
import { SEAT_QUANTITY } from "./organization-seat-operation-store.js";
import { SEAT_QUANTITY_ROUTES as routes, toQuantityPreview } from "./organization-seat-quantity-wire.js";
import { Refused } from "./session.js";

/**
 * Changing how many seats an organization pays for: the server's review of a number, then a journaled change. The
 * number is kept beside the request only to say what was asked; the server acts on the review it issued.
 */
export class OrganizationSeatQuantity {
  readonly #changes: SeatChanges<SeatQuantityRequest>;
  constructor(private readonly deps: SeatChangeDeps) {
    this.#changes = new SeatChanges(deps, SEAT_QUANTITY, { submit: () => routes.confirm, read: routes.operation });
  }

  async preview(input: number): Promise<SeatQuantityPreview> {
    const seats = seatQuantity.parse(input);
    const preview = toQuantityPreview(await this.#changes.request(routes.preview, { seats }));
    if (preview.to !== seats || preview.expiresAt <= this.deps.now()) throw new Refused("The seats have changed. Review the change again.", 409);
    return preview;
  }

  send(request: SeatQuantityRequest): Promise<SeatQuantityWork> {
    return this.#changes.send(request);
  }
  read(id: string): Promise<SeatQuantityWork | null> {
    return this.#changes.read(id);
  }
  /** The latest change while it is unsettled, failed, or settled with its read still owed; nothing once it is done. */
  open(): SeatQuantityWork[] {
    const latest = this.#changes.list().at(-1);
    return latest && (latest.operation?.state !== "complete" || latest.error !== null) ? [latest] : [];
  }
  reconcile(): Promise<void> {
    return this.#changes.reconcile();
  }
  close(): void {
    this.#changes.close();
  }
}
