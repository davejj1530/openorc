import type { OrganizationIdentity } from "@openorc/protocol";
import { TopBar } from "../components/TopBar";
import { OrganizationMark } from "../components/OrganizationMark";
import { Button } from "../components/ui";
import { useRpcMutation } from "../lib/client";

export function OrganizationEmpty({
  organization,
  onAddProjects,
  onInvite,
  pendingLogo,
  onLogoSaved,
}: {
  organization: OrganizationIdentity;
  onAddProjects(): void;
  onInvite(): void;
  pendingLogo?: string | null;
  onLogoSaved?(): void;
}) {
  const update = useRpcMutation("organization.update");
  return (
    <main className="workspace-main well flex flex-1 flex-col min-w-0 min-h-0">
      <TopBar>{null}</TopBar>
      <div className="organization-empty flex-1">
        <div className="organization-empty-content">
          <div className="organization-empty-identity">
            <OrganizationMark name={organization.name} logo={organization.logo} size={40} />
            <h1 className="new-thread-question">{organization.name}</h1>
          </div>
          <div className="organization-empty-actions">
            <Button variant="primary" size="xl" onClick={onAddProjects}>
              Add projects from GitHub
            </Button>
            <Button size="xl" onClick={onInvite}>
              Invite people
            </Button>
          </div>
          {pendingLogo ? (
            <div className="organization-logo-retry" role="alert">
              <span>{update.error?.message ?? "The logo couldn't be saved."}</span>
              <Button size="sm" disabled={update.isPending} onClick={() => update.mutate({ spaceId: organization.id, logo: pendingLogo }, { onSuccess: onLogoSaved })}>
                Try again
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
