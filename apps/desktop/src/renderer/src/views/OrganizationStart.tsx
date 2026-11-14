import type { ReactNode } from "react";
import { useOrganization } from "../lib/organization-context";
import { useSpaceNavigation } from "../lib/space-navigation";
import { TopBar } from "../components/TopBar";
import { OrganizationEmpty } from "./OrganizationEmpty";
import { OrganizationNoProjects } from "./OrganizationNoProjects";

export function OrganizationStart({ projectId, children }: { projectId?: string; children: ReactNode }) {
  const actions = useOrganization();
  const space = useSpaceNavigation((state) => state.inventory.find((space) => space.id === state.current));
  const organization = actions?.organization;
  if (!organization || !space || space.projects.length || (projectId && space.detached?.projects.some((project) => project.key === projectId))) return children;
  if (organization.role === "admin")
    return <OrganizationEmpty organization={organization} onAddProjects={actions.addProjects} onInvite={actions.invite} pendingLogo={actions.pendingLogo} onLogoSaved={actions.logoSaved} />;
  return (
    <main className="workspace-main well flex flex-1 flex-col min-w-0 min-h-0">
      <TopBar>{null}</TopBar>
      <OrganizationNoProjects organization={organization} onPeople={() => actions.people()} />
    </main>
  );
}
