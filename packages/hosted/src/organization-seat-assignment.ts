import { SeatAssignmentTarget, type OrganizationSeatPreview, type SeatAssignmentRequest, type SeatAssignmentWork } from "@openorc/protocol";
import { SEAT_ASSIGNMENT_ROUTES as routes, toSeatPreview } from "./organization-seat-assignment-wire.js";
import { SeatChanges, type SeatChangeDeps } from "./organization-seat-changes.js";
import { SEAT_ASSIGNMENT } from "./organization-seat-operation-store.js";
import { Refused } from "./session.js";

export type SeatAssignmentDeps = SeatChangeDeps;

/** Giving, moving and taking back one seat: a server review, then a journaled change. */
export class OrganizationSeatAssignment {
  readonly #changes: SeatChanges<SeatAssignmentRequest>;
  constructor(private readonly deps: SeatAssignmentDeps) {
    this.#changes = new SeatChanges(deps, SEAT_ASSIGNMENT, { submit: (request) => routes.assign(request.seatId), read: routes.operation });
  }

  async preview(input: SeatAssignmentTarget): Promise<OrganizationSeatPreview> {
    const target = SeatAssignmentTarget.parse(input);
    const preview = toSeatPreview(await this.#changes.request(routes.preview(target.seatId), { memberId: target.memberId }));
    if (preview.seat.id !== target.seatId || (preview.to?.memberId ?? null) !== target.memberId || preview.expiresAt <= this.deps.now()) {
      throw new Refused("That seat has changed. Review the change again.", 409);
    }
    return preview;
  }

  send(request: SeatAssignmentRequest): Promise<SeatAssignmentWork> {
    return this.#changes.send(request);
  }
  read(id: string): Promise<SeatAssignmentWork | null> {
    return this.#changes.read(id);
  }
  list(): SeatAssignmentWork[] {
    return this.#changes.list();
  }
  reconcile(): Promise<void> {
    return this.#changes.reconcile();
  }
  close(): void {
    this.#changes.close();
  }
}
