import type { ReactNode } from "react";
import { useOrganization } from "../lib/organization-context";
import { useOrganizationStart } from "../lib/organization-start";
import { TopBar } from "../components/TopBar";
import { OrganizationEmpty } from "./OrganizationEmpty";
import { OrganizationNoProjects } from "./OrganizationNoProjects";

export function OrganizationStart({ projectId, children }: { projectId?: string; children: ReactNode }) {
  const actions = useOrganization();
  const shown = useOrganizationStart(projectId);
  const organization = actions?.organization;
  if (!shown || !organization) return children;
  if (organization.role === "admin")
    return <OrganizationEmpty organization={organization} onAddProjects={actions.addProjects} onInvite={actions.invite} pendingLogo={actions.pendingLogo} onLogoSaved={actions.logoSaved} />;
  return (
    <main className="workspace-main well flex flex-1 flex-col min-w-0 min-h-0">
      <TopBar>{null}</TopBar>
      <OrganizationNoProjects organization={organization} onPeople={() => actions.people()} />
    </main>
  );
}
