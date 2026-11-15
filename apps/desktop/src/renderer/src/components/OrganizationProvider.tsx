import type { ReactNode } from "react";
import { OrganizationIdentityDialog } from "../dialogs/OrganizationIdentityDialog";
import { OrganizationInviteDialog } from "../dialogs/OrganizationInviteDialog";
import { OrganizationProjectsDialog } from "../dialogs/OrganizationProjectsDialog";
import { ReceivedInvitationDialog } from "../dialogs/ReceivedInvitationDialog";
import { OrganizationContext } from "../lib/organization-context";
import { useOrganizationController } from "../lib/organization-controller";

/** All organization entry points share this window's decisions and captured dialog targets. */
export function OrganizationProvider({ children }: { children: ReactNode }) {
  const { actions, saved, accountKey } = useOrganizationController();
  const dialog = actions.dialog;
  return (
    <OrganizationContext.Provider value={actions}>
      {children}
      <div key={accountKey}>
        {dialog?.kind === "create" ? (
          <OrganizationIdentityDialog
            open
            onOpenChange={(open) => {
              if (!open) actions.close();
            }}
            onSaved={saved}
          />
        ) : null}
        {dialog?.kind === "invite" ? (
          <OrganizationInviteDialog organization={dialog.organization} onClose={actions.close} onViewInvitations={() => actions.people("invitations")} onBuySeats={() => actions.people("seats")} />
        ) : null}
        {dialog?.kind === "projects" ? (
          <OrganizationProjectsDialog
            open
            spaceId={dialog.spaceId}
            onOpenChange={(open) => {
              if (!open) actions.close();
            }}
            onAdded={actions.refresh}
          />
        ) : null}
        <ReceivedInvitationDialog actions={actions.invitations} />
      </div>
    </OrganizationContext.Provider>
  );
}
