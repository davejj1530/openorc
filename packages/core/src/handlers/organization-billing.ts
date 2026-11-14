import type { OrganizationBillingOffers, OrganizationBillingPage, OrganizationBillingParams, OrganizationBillingRpcResults, OrganizationBillingStatus } from "@openorc/protocol";
import type { Hosted } from "@openorc/hosted";
import { createAccountHandlers } from "./account.js";
import { createOrganizationStorageHandlers } from "./organization-storage.js";
import { createOrganizationSeatHandlers } from "./organization-seat-assignment.js";

export function createHostedAccountHandlers(hosted: Hosted | null) {
  return {
    ...createAccountHandlers(hosted?.account ?? null),
    ...createOrganizationBillingHandlers(hosted?.organizationBilling ?? null),
    ...createOrganizationStorageHandlers(hosted?.organizationBilling ?? null),
    ...createOrganizationSeatHandlers(hosted?.organizationBilling.seats ?? null),
  };
}

interface BillingCalls {
  read(spaceId: string): Promise<OrganizationBillingStatus>;
  offers(spaceId: string, seats: number): Promise<OrganizationBillingOffers>;
  open(spaceId: string, target: OrganizationBillingPage): Promise<OrganizationBillingStatus>;
  leave(spaceId: string): OrganizationBillingStatus;
}
type BillingHandlers = { [M in keyof OrganizationBillingRpcResults]: (input: OrganizationBillingParams<M>) => Promise<OrganizationBillingRpcResults[M]> | OrganizationBillingRpcResults[M] };

/** Organization administration stays in desktop core, outside paired-phone and thread routing. */
export function createOrganizationBillingHandlers(billing: BillingCalls | null): BillingHandlers {
  const service = () => {
    if (!billing) throw new Error("Organization seats aren't available here.");
    return billing;
  };
  return {
    "organization.billing.get": ({ spaceId }) => service().read(spaceId),
    "organization.billing.offers": ({ spaceId, seats }) => service().offers(spaceId, seats),
    "organization.billing.open": ({ spaceId, target }) => service().open(spaceId, target),
    "organization.billing.leave": ({ spaceId }) => service().leave(spaceId),
  };
}
