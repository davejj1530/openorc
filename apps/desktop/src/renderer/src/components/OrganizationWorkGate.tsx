import type { ReactNode } from "react";
import { useOrganizationContentGate } from "../lib/organization-content-gate";
import { useRouter, type Route } from "../lib/router";
import { useSpaceNavigation } from "../lib/space-navigation";
import { FrozenOrganization } from "./OrganizationAccessGate";

/** What a frozen person keeps: their own settings and Orcling designer, and for an admin, People and Seats. */
function stillOpen(route: Route, admin: boolean): boolean {
  if (route.view === "settings" || route.view === "orcling" || route.view === "diagnostics") return true;
  return admin && route.view === "people";
}

/**
 * The work area of an organization space: the one frozen screen in place of the organization's work when the server says
 * this person's access is frozen, so every surface they open says why and the way back. Nothing changes while access
 * is open or still being read, in Personal, or on the routes a frozen person keeps.
 */
export function OrganizationWorkGate({ route, children }: { route: Route; children: ReactNode }) {
  const current = useSpaceNavigation((state) => state.current);
  const personal = useSpaceNavigation((state) => state.personal);
  const organization = current !== null && current !== personal ? current : null;
  const gate = useOrganizationContentGate(organization);
  const space = gate.space?.kind === "organization" ? gate.space : null;
  if (!organization || gate.blocked !== "frozen" || gate.access?.state !== "frozen" || !space || stillOpen(route, space.role === "admin")) return <>{children}</>;
  return (
    <main className="well flex-1 min-w-0 flex flex-col">
      <FrozenOrganization organization={space} access={gate.access} onAccount={() => useRouter.getState().navigate({ view: "settings", section: "account" })} />
    </main>
  );
}
