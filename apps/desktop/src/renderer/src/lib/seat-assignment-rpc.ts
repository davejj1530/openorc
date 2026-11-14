import type { OrganizationSeatReply } from "@openorc/protocol";
import type { SeatAssignmentTransport } from "./seat-assignment-scope";
import { organizationBillingTransport } from "./organization-billing-rpc";
import { core } from "./rpc";
import { SeatAdministrationLost } from "./seat-administration-lost";

function value<T>(reply: OrganizationSeatReply<T>): T {
  if (reply.state === "denied") throw new SeatAdministrationLost(reply.message);
  return reply.value;
}

export const seatAssignmentTransport: SeatAssignmentTransport = {
  preview: (spaceId, target) => core.call("organization.seat.preview", { spaceId, target }).then(value),
  assign: (spaceId, request) => core.call("organization.seat.assign", { spaceId, request }).then(value),
  operation: (spaceId, id) => core.call("organization.billing.operation", { spaceId, id }).then(value),
  subscribe: organizationBillingTransport.subscribe,
};
