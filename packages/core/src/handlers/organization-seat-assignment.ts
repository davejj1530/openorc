import type { OrganizationSeatAdministration } from "@openorc/hosted";
import type { SeatAssignmentRequest, SeatAssignmentTarget, SeatQuantityRequest } from "@openorc/protocol";

type Seats = Pick<OrganizationSeatAdministration, "preview" | "assign" | "operation" | "previewQuantity" | "setQuantity" | "quantityOperation">;

export function createOrganizationSeatHandlers(seats: Seats | null) {
  const service = () => {
    if (!seats) throw new Error("Organization seats aren't available here.");
    return seats;
  };
  return {
    "organization.seat.preview": ({ spaceId, target }: { spaceId: string; target: SeatAssignmentTarget }) => service().preview(spaceId, target),
    "organization.seat.assign": ({ spaceId, request }: { spaceId: string; request: SeatAssignmentRequest }) => service().assign(spaceId, request),
    "organization.billing.operation": ({ spaceId, id }: { spaceId: string; id: string }) => service().operation(spaceId, id),
    "organization.billing.previewQuantity": ({ spaceId, seats }: { spaceId: string; seats: number }) => service().previewQuantity(spaceId, seats),
    "organization.billing.setQuantity": ({ spaceId, request }: { spaceId: string; request: SeatQuantityRequest }) => service().setQuantity(spaceId, request),
    "organization.billing.quantityOperation": ({ spaceId, id }: { spaceId: string; id: string }) => service().quantityOperation(spaceId, id),
  };
}
