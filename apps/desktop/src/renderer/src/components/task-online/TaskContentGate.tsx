import type { ReactNode } from "react";
import { useSpaceNavigation } from "../../lib/space-navigation";
import { OrganizationAccessGate } from "../OrganizationAccessGate";

export function TaskContentGate({ children, spaceId }: { children: ReactNode; spaceId?: string }) {
  const current = useSpaceNavigation((state) => state.inventory.find((space) => space.id === state.current));
  return <OrganizationAccessGate spaceId={spaceId ?? (current && !current.personal ? current.id : null)}>{children}</OrganizationAccessGate>;
}
