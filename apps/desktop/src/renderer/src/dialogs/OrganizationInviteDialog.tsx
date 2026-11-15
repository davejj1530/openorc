import type { OrganizationIdentity, OrganizationInviteResult } from "@openorc/protocol";
import { Check } from "../components/icons";
import { Button, Dialog, Textarea } from "../components/ui";
import { cn } from "../lib/cn";
import { useRpc } from "../lib/client";
import { InvitationSeatChoices } from "../components/InvitationSeatChoices";
import { useInviteForm } from "../lib/invite-form";
import { invitationOutcome, seatNotHeld, type InvitationSent } from "../lib/organization-invitations";
import { OrganizationInviteRole } from "./OrganizationInviteRole";
import "./organization-invitations.css";

const NEEDS_SEAT = "Each invitation needs a seat while your account is frozen.";

export function OrganizationInviteDialog({
  organization,
  onClose,
  onViewInvitations,
  onBuySeats,
}: {
  organization: OrganizationIdentity;
  onClose(): void;
  onViewInvitations(): void;
  /** Leaves for the organization's seats; the unsent draft is shown again when the form next opens. */
  onBuySeats?(): void;
}) {
  const form = useInviteForm(organization.id, onBuySeats);
  const { addresses, batch } = form;
  const admin = useInviteRight(organization.id);
  const { denied } = admin;
  const finished = batch.results.length > 0 && !batch.pending && !form.retry;
  const close = () => {
    batch.cancel();
    onClose();
  };
  const invalid = addresses.invalid.length > 0 || addresses.emails.length > 30;
  const disabled = !admin.ready || invalid || !addresses.emails.length || batch.pending || form.needsSeat;
  return (
    <Dialog
      open
      title={inviteTitle(organization.name, finished, batch.results)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      width={480}
    >
      <form
        className="organization-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) form.send();
        }}
      >
        {!finished ? (
          <>
            <label className="organization-label">
              Email addresses
              <Textarea
                rows={3}
                variant="sheet"
                aria-label="Email addresses"
                autoFocus
                value={form.text}
                disabled={batch.pending}
                aria-invalid={invalid}
                onChange={(event) => form.edit(event.target.value)}
              />
            </label>
            <AddressErrors invalid={addresses.invalid} duplicates={addresses.duplicates} tooMany={addresses.emails.length > 30} />
            <OrganizationInviteRole role={form.role} disabled={batch.pending} onChange={form.setRole} />
            {form.seats ? <InvitationSeatChoices {...form.seats} disabled={batch.pending} onSwitch={form.switchSeat} onBuySeats={form.buySeats} /> : null}
          </>
        ) : null}
        {batch.results.length ? <InviteResults results={batch.results} /> : null}
        {denied ? (
          <p className="organization-error" role="alert">
            {denied}
          </p>
        ) : null}
        <InviteActions
          results={batch.results}
          pending={batch.pending}
          finished={finished}
          retry={form.retry}
          disabled={disabled}
          reason={form.needsSeat ? NEEDS_SEAT : undefined}
          close={close}
          view={() => {
            close();
            onViewInvitations();
          }}
        />
      </form>
    </Dialog>
  );
}

/** Whether this person may invite here, as the server's own roster says. */
function useInviteRight(spaceId: string): { ready: boolean; denied: string | null } {
  const people = useRpc("organization.people", { spaceId, offset: 0, limit: 1 });
  const denied = people.error?.message ?? (people.data && people.data.viewer.role !== "admin" ? "Only an admin can do that." : null);
  return { ready: Boolean(people.data) && !denied, denied };
}

function AddressErrors({ invalid, duplicates, tooMany }: { invalid: string[]; duplicates: string[]; tooMany: boolean }) {
  if (!invalid.length && !duplicates.length && !tooMany) return null;
  return (
    <div className="organization-invite-errors">
      {invalid.map((email) => (
        <div key={email}>
          <span>{email}</span>
          <span className="organization-error">Enter a full email address.</span>
        </div>
      ))}
      {duplicates.map((email) => (
        <div key={email}>
          <span>{email}</span>
          <span className="text-ink-3">Already added.</span>
        </div>
      ))}
      {tooMany ? <p className="organization-error">Invite up to 30 people at a time.</p> : null}
    </div>
  );
}

function InviteResults({ results }: { results: InvitationSent[] }) {
  return (
    <div className="organization-invite-results" aria-live="polite">
      {results.map((result) => {
        const label = invitationOutcome(result);
        const failure = result.state === "refused" || (result.state === "sent" && result.invitation?.delivery?.status === "failed");
        const read = result.state === "sent" ? (result.error ?? result.invitation?.delivery?.reason) : null;
        const detail = read ?? (seatNotHeld(result) ? "The seat wasn't held for this invitation." : null);
        return (
          <div key={result.email} className={cn("organization-invite-result", result.state === "refused" && "organization-invite-refusal")}>
            <div className="organization-invite-result-row">
              <span>{result.email}</span>
              <span className={cn("organization-invite-outcome", failure && "organization-error")}>
                {label.startsWith("Sent") ? <Check size={14} /> : null}
                {label}
              </span>
            </div>
            {detail ? <p className="organization-small">{detail}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

function InviteActions({
  results,
  pending,
  finished,
  retry,
  disabled,
  reason,
  close,
  view,
}: {
  results: OrganizationInviteResult[];
  pending: boolean;
  finished: boolean;
  retry: boolean;
  disabled: boolean;
  /** Why nothing can be sent, shown on demand. */
  reason: string | undefined;
  close(): void;
  view(): void;
}) {
  const sendLabel = retry ? "Try again" : "Send invitations";
  return (
    <div className="organization-actions">
      {results.some((result) => result.state !== "refused") ? (
        <Button variant="ghost" onClick={view}>
          View invitations
        </Button>
      ) : null}
      {finished ? (
        <Button variant="primary" onClick={close}>
          Done
        </Button>
      ) : (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={disabled} data-tip={reason}>
            {pending ? "Sending…" : sendLabel}
          </Button>
        </>
      )}
    </div>
  );
}

function inviteTitle(name: string, finished: boolean, results: InvitationSent[]) {
  if (!finished) return `Invite people to ${name}`;
  return results.every((result) => invitationOutcome(result).startsWith("Sent") && !seatNotHeld(result)) ? "Invitations sent" : "Invitations";
}
