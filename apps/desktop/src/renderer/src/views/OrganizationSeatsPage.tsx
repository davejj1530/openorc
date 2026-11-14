import { useOrganizationBilling } from "../lib/organization-billing";
import { organizationBillingTransport } from "../lib/organization-billing-rpc";
import { organizationStorageTransport } from "../lib/organization-storage-rpc";
import { OrganizationSeats } from "./OrganizationSeats";
import { useSeatAdministration } from "../lib/seat-administration";

export function OrganizationSeatsPage({ spaceId }: { spaceId: string }) {
  const admin = useSeatAdministration();
  return admin ? <OrganizationSeats spaceId={spaceId} view={admin.scope.view} offers={admin.scope.offers} storage={organizationStorageTransport} /> : <StandaloneSeats spaceId={spaceId} />;
}
function StandaloneSeats({ spaceId }: { spaceId: string }) {
  const scope = useOrganizationBilling(spaceId, organizationBillingTransport);
  return scope ? (
    <OrganizationSeats key={scope.identity} spaceId={spaceId} view={scope.view} offers={scope.offers} storage={organizationStorageTransport} />
  ) : (
    <p className="seats-inline-state text-ink-3">Loading seats…</p>
  );
}
