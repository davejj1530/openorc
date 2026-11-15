import type { OrganizationSeatReply } from "@openorc/protocol";
import { organizationBillingTransport } from "./organization-billing-rpc";
import { core } from "./rpc";
import { SeatAdministrationLost } from "./seat-administration-lost";
import type { SeatQuantityTransport } from "./seat-quantity-scope";

function value<T>(reply: OrganizationSeatReply<T>): T {
  if (reply.state === "denied") throw new SeatAdministrationLost(reply.message);
  return reply.value;
}
/** A core from before this call says so in words, rather than failing as an unknown method. */
function known(error: unknown): never {
  if (error instanceof Error && /^unknown method organization\.billing\.(previewQuantity|setQuantity|quantityOperation)$/.test(error.message))
    throw new Error("Update OpenOrc to change the number of seats.");
  throw error;
}

export const seatQuantityTransport: SeatQuantityTransport = {
  preview: (spaceId, seats) => core.call("organization.billing.previewQuantity", { spaceId, seats }).then(value, known),
  confirm: (spaceId, request) => core.call("organization.billing.setQuantity", { spaceId, request }).then(value, known),
  operation: (spaceId, id) => core.call("organization.billing.quantityOperation", { spaceId, id }).then(value, known),
  subscribe: organizationBillingTransport.subscribe,
};
