import { useSyncExternalStore } from "react";
import type { OrganizationSeat } from "@openorc/protocol";
import { useFrozenReason } from "./organization-authority";
import { useOrganizationBilling } from "./organization-billing";
import { organizationBillingTransport } from "./organization-billing-rpc";
import { ORGANIZATION_SEATS_ENABLED } from "./organization-section";

export interface InvitationSeatInventory {
  /** The organization's seats an invitation could hold now; none while its seats are unpaid. */
  seats: readonly OrganizationSeat[];
  /** The admin is frozen: every invitation they send must hold a seat. */
  frozen: boolean;
}

const idle = () => () => {};
const nothing = () => null;

/**
 * The seats an admin can offer with an invitation, or null where the form has nothing to say about seats: the
 * organization has bought none, or its seats cannot be read. A frozen admin always gets the choice, since a seat is
 * the only way they may invite.
 */
export function useInvitationSeatInventory(spaceId: string): InvitationSeatInventory | null {
  const scope = useOrganizationBilling(spaceId, organizationBillingTransport);
  const state = useSyncExternalStore(scope?.view.subscribe ?? idle, scope?.view.getSnapshot ?? nothing);
  const frozen = useFrozenReason(spaceId) !== undefined;
  const status = ORGANIZATION_SEATS_ENABLED ? state?.status : null;
  const billing = status?.billing;
  if (!billing || (!billing.subscription && !frozen)) return null;
  const paid = billing.subscription?.standing === "live" || billing.subscription?.standing === "ending";
  const moving = new Set(status?.assignments?.filter((work) => !work.operation || work.operation.state === "pending").map((work) => work.request.seatId));
  return { seats: paid ? billing.seats.filter((seat) => !moving.has(seat.id)) : [], frozen };
}
