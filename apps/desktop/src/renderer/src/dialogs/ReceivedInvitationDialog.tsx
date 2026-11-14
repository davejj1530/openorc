import type { ReceivedInvitation } from "@openorc/protocol";
import { Button, Dialog } from "../components/ui";
import { OrganizationMark } from "../components/OrganizationMark";
import { AccountFace } from "../components/AccountFace";
import { inviterLine, type ReceivedInvitationActions } from "../lib/received-invitations";
import "./received-invitations.css";

export function ReceivedInvitationDialog({ actions }: { actions: ReceivedInvitationActions }) {
  const decision = actions.decision;
  if (!decision?.detail) return null;
  const { invitation, declined, pending, error, joined } = decision;
  let joinLabel = `Join ${invitation.organization.name}`;
  if (joined) joinLabel = `Open ${invitation.organization.name}`;
  if (pending === "join") joinLabel = joined ? "Opening…" : "Joining…";
  return (
    <Dialog
      open
      title={declined ? "Invitation declined" : `Join ${invitation.organization.name}`}
      width={declined ? 400 : 440}
      onOpenChange={(open) => {
        if (!open) actions.close();
      }}
    >
      <div className="organization-form">
        {declined ? (
          <p className="text-ink-3">You haven't joined {invitation.organization.name}.</p>
        ) : (
          <>
            <InvitationIdentity invitation={invitation} />
            <div className="organization-received-email">{invitation.email}</div>
            {joined ? <p>You joined {invitation.organization.name}.</p> : null}
            {error ? (
              <p className="organization-error" role="alert">
                {error}
              </p>
            ) : null}
          </>
        )}
        <div className="organization-actions">
          {declined ? (
            <Button variant="primary" onClick={actions.close}>
              Done
            </Button>
          ) : (
            <>
              {!joined ? (
                <Button variant="ghost" disabled={Boolean(pending)} onClick={() => void actions.respond(invitation, "decline", true)}>
                  {pending === "decline" ? "Declining…" : "Decline"}
                </Button>
              ) : null}
              <Button variant="primary" className="organization-received-join" disabled={Boolean(pending)} onClick={() => void actions.respond(invitation, "join", true)}>
                <span data-tip={joinLabel}>{joinLabel}</span>
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function InvitationIdentity({ invitation }: { invitation: ReceivedInvitation }) {
  return (
    <div className="organization-received-identity">
      <OrganizationMark {...invitation.organization} size={44} />
      <div className="organization-received-person">
        {invitation.inviter.name ? <AccountFace name={invitation.inviter.name} image={invitation.inviter.image ?? null} /> : null}
        <div>
          {inviterLine(invitation)}
          {invitation.inviter.name ? "." : null}
          {invitation.inviter.email ? <p className="text-ink-3">{invitation.inviter.email}</p> : null}
        </div>
      </div>
    </div>
  );
}
