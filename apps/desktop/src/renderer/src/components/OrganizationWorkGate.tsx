import { useState, type ReactNode } from "react";
import { OrganizationMembershipDialog } from "../dialogs/OrganizationMembershipDialog";
import { useFrozenWork } from "../lib/organization-frozen-work";
import { useOrganization } from "../lib/organization-context";
import { useRouter, type Route } from "../lib/router";
import { OrganizationLeaveMenu } from "../views/OrganizationMenus";
import { FrozenOrganization } from "./OrganizationAccessGate";

/**
 * The work area of an organization space: the one frozen screen in place of the organization's work when the server says
 * this person's access is frozen, so every surface they open says why and the way back. Nothing changes while access
 * is open or still being read, in Personal, or on the routes a frozen person keeps.
 */
export function OrganizationWorkGate({ route, children }: { route: Route; children: ReactNode }) {
  const frozen = useFrozenWork(route);
  const organizations = useOrganization();
  const [leaving, setLeaving] = useState<HTMLButtonElement | null | false>(false);
  if (!frozen) return <>{children}</>;
  const close = () => {
    if (leaving && leaving.isConnected) leaving.focus();
    setLeaving(false);
  };
  // A frozen admin keeps People, whose own "…" holds the whole menu; a member leaves from here.
  const menu = frozen.space.role === "admin" ? null : <OrganizationLeaveMenu name={frozen.space.name} onLeave={setLeaving} />;
  return (
    <main className="well flex-1 min-w-0 flex flex-col">
      <FrozenOrganization organization={frozen.space} access={frozen.access} menu={menu} onAccount={() => useRouter.getState().navigate({ view: "settings", section: "account" })} />
      {leaving !== false ? <OrganizationMembershipDialog action={{ kind: "leave", organization: frozen.space }} onClose={close} onDone={() => organizations?.refresh()} /> : null}
    </main>
  );
}
