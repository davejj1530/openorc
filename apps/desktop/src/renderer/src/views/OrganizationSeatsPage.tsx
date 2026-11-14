import { useOrganizationBilling } from "../lib/organization-billing";
import { organizationBillingTransport } from "../lib/organization-billing-rpc";
import { organizationStorageTransport } from "../lib/organization-storage-rpc";
import { OrganizationSeats } from "./OrganizationSeats";

export function OrganizationSeatsPage({ spaceId }: { spaceId: string }) {
  const scope = useOrganizationBilling(spaceId, organizationBillingTransport);
  return scope ? (
    <OrganizationSeats key={scope.identity} spaceId={spaceId} view={scope.view} offers={scope.offers} storage={organizationStorageTransport} />
  ) : (
    <p className="seats-inline-state text-ink-3">Loading seats…</p>
  );
}
