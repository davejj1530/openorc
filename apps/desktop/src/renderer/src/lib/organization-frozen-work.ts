import { useOrganizationContentGate } from "./organization-content-gate";
import type { Route } from "./router";
import { useSpaceNavigation } from "./space-navigation";

/** What a frozen person keeps: their own settings and Orcling designer, and for an admin, People and Seats. */
function stillOpen(route: Route, admin: boolean): boolean {
  if (route.view === "settings" || route.view === "orcling" || route.view === "diagnostics") return true;
  return admin && route.view === "people";
}

/** The organization and its frozen access when the frozen screen stands in for this route's work, else null. */
export function useFrozenWork(route: Route) {
  const current = useSpaceNavigation((state) => state.current);
  const personal = useSpaceNavigation((state) => state.personal);
  const organization = current !== null && current !== personal ? current : null;
  const gate = useOrganizationContentGate(organization);
  const space = gate.space?.kind === "organization" ? gate.space : null;
  if (!organization || gate.blocked !== "frozen" || gate.access?.state !== "frozen" || !space || stillOpen(route, space.role === "admin")) return null;
  return { space, access: gate.access };
}
