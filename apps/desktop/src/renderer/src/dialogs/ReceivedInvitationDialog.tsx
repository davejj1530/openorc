import { Button, Dialog } from "../components/ui";
import { OrganizationMark } from "../components/OrganizationMark";
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
            <div className="organization-received-identity">
              <OrganizationMark {...invitation.organization} size={44} />
              <div>
                {inviterLine(invitation)}
                {invitation.inviter.name ? "." : null}
                {invitation.inviter.email ? <p className="text-ink-3">{invitation.inviter.email}</p> : null}
              </div>
            </div>
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
              <Button variant="primary" disabled={Boolean(pending)} onClick={() => void actions.respond(invitation, "join", true)}>
                {joinLabel}
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
