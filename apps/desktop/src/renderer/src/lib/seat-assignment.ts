import { OrganizationSeatPreview, SeatAssignmentWork, type SeatAssignmentRequest, type SeatAssignmentTarget } from "@openorc/protocol";
import { SeatChangeFlow, type SeatChangeDeps, type SeatChangeKind, type SeatChangeState } from "./seat-change-flow";

export type { SeatAssignmentTarget } from "@openorc/protocol";
export type SeatAssignmentState = SeatChangeState<SeatAssignmentTarget, OrganizationSeatPreview, SeatAssignmentWork>;
export type SeatAssignmentDeps = SeatChangeDeps<SeatAssignmentTarget, OrganizationSeatPreview, SeatAssignmentRequest, SeatAssignmentWork>;

const kind: SeatChangeKind<SeatAssignmentTarget, OrganizationSeatPreview, SeatAssignmentRequest, SeatAssignmentWork> = {
  preview: OrganizationSeatPreview,
  work: SeatAssignmentWork,
  answers: (preview, target) => preview.seat.id === target.seatId && (preview.to?.memberId ?? null) === target.memberId,
  request: (preview, id) => ({ seatId: preview.seat.id, body: { id, previewToken: preview.token } }),
  target: (preview, work) => (preview.seat.id === work.request.seatId ? { seatId: preview.seat.id, memberId: preview.to?.memberId ?? null } : null),
  stale: "That seat has changed. Review the change again.",
};

/** Giving, moving or taking back one seat. */
export class SeatAssignment extends SeatChangeFlow<SeatAssignmentTarget, OrganizationSeatPreview, SeatAssignmentRequest, SeatAssignmentWork> {
  constructor(deps: SeatAssignmentDeps) {
    super(kind, deps);
  }
}
