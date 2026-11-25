import type { ReactNode } from "react";
import { useOrganizationContentGate } from "../lib/organization-content-gate";
import { useSpaceNavigation } from "../lib/space-navigation";

/** Personal navigation stays available while organization content is closed, and `closed` stands where the work would. */
export function OrganizationSidebarWork({ closed, children }: { closed: ReactNode; children: ReactNode }) {
  const spaceId = useSpaceNavigation((state) => state.current);
  const personal = useSpaceNavigation((state) => state.personal);
  const gate = useOrganizationContentGate(spaceId);
  return !spaceId || spaceId === personal || gate.allowed ? <>{children}</> : <>{closed}</>;
}
