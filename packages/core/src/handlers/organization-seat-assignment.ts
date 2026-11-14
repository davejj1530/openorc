import type { OrganizationSeatAdministration } from "@openorc/hosted";
import type { SeatAssignmentRequest, SeatAssignmentTarget } from "@openorc/protocol";

export function createOrganizationSeatHandlers(seats: Pick<OrganizationSeatAdministration, "preview" | "assign" | "operation"> | null) {
  const service = () => {
    if (!seats) throw new Error("Organization seats aren't available here.");
    return seats;
  };
  return {
    "organization.seat.preview": ({ spaceId, target }: { spaceId: string; target: SeatAssignmentTarget }) => service().preview(spaceId, target),
    "organization.seat.assign": ({ spaceId, request }: { spaceId: string; request: SeatAssignmentRequest }) => service().assign(spaceId, request),
    "organization.billing.operation": ({ spaceId, id }: { spaceId: string; id: string }) => service().operation(spaceId, id),
  };
}
