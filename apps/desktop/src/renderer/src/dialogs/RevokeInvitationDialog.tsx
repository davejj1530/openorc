import { Button, Dialog } from "../components/ui";
import { useRpcMutation } from "../lib/client";

/** Asks before an invitation is revoked. A seat it held is free again once the server has revoked it. */
export function RevokeInvitationDialog({ spaceId, invitationId, email, onClose }: { spaceId: string; invitationId: string; email: string; onClose(): void }) {
  const revoke = useRpcMutation("organization.invitation.revoke");
  return (
    <Dialog
      open
      title="Revoke invitation?"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      width={420}
    >
      <div className="organization-form">
        <p className="text-ink-3">{email} won't be able to join with this invitation.</p>
        {revoke.error ? (
          <p className="organization-error" role="alert">
            {revoke.error.message}
          </p>
        ) : null}
        <div className="organization-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={revoke.isPending} onClick={() => revoke.mutate({ spaceId, invitationId }, { onSuccess: onClose })}>
            {revoke.isPending ? "Revoking…" : "Revoke invitation"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
