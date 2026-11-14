import { useState } from "react";
import type { OrganizationIdentity, OrganizationInviteResult, OrganizationRole } from "@openorc/protocol";
import { Check } from "../components/icons";
import { Button, Dialog, Textarea } from "../components/ui";
import { cn } from "../lib/cn";
import { useRpc } from "../lib/client";
import { invitationAddresses, invitationOutcome, useInvitationBatch } from "../lib/organization-invitations";
import { OrganizationInviteRole } from "./OrganizationInviteRole";
import "./organization-invitations.css";

export function OrganizationInviteDialog({ organization, onClose, onViewInvitations }: { organization: OrganizationIdentity; onClose(): void; onViewInvitations(): void }) {
  const [text, setText] = useState("");
  const [role, setRole] = useState<OrganizationRole>("member");
  const batch = useInvitationBatch(organization.id);
  const people = useRpc("organization.people", { spaceId: organization.id, offset: 0, limit: 1 });
  const denied = people.error?.message ?? (people.data && people.data.viewer.role !== "admin" ? "Only an admin can do that." : null);
  const addresses = invitationAddresses(text);
  const refused = batch.results.filter((result) => result.state === "refused");
  const finished = batch.results.length > 0 && !batch.pending && !refused.length;
  const title = inviteTitle(organization.name, finished, batch.results);
  const close = () => {
    batch.cancel();
    onClose();
  };
  const send = () => void batch.send(refused.length ? refused.map((result) => result.email) : addresses.emails, role);
  const invalid = addresses.invalid.length > 0 || addresses.emails.length > 30;
  const disabled = !people.data || Boolean(denied) || invalid || !addresses.emails.length || batch.pending;
  return (
    <Dialog
      open
      title={title}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      width={480}
    >
      <form
        className="organization-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) send();
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
                value={text}
                disabled={batch.pending}
                aria-invalid={invalid}
                onChange={(event) => {
                  setText(event.target.value);
                  batch.reset();
                }}
              />
            </label>
            <AddressErrors invalid={addresses.invalid} duplicates={addresses.duplicates} tooMany={addresses.emails.length > 30} />
            <OrganizationInviteRole role={role} disabled={batch.pending} onChange={setRole} />
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
          retry={refused.length > 0}
          disabled={disabled}
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

function InviteResults({ results }: { results: OrganizationInviteResult[] }) {
  return (
    <div className="organization-invite-results" aria-live="polite">
      {results.map((result) => {
        const label = invitationOutcome(result);
        const failure = result.state === "refused" || (result.state === "sent" && result.invitation?.delivery?.status === "failed");
        const detail = result.state === "sent" ? (result.error ?? result.invitation?.delivery?.reason) : null;
        return (
          <div key={result.email} className={cn("organization-invite-result", result.state === "refused" && "organization-invite-refusal")}>
            <div className="organization-invite-result-row">
              <span>{result.email}</span>
              <span className={cn("organization-invite-outcome", failure && "organization-error")}>
                {label === "Sent" ? <Check size={14} /> : null}
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
  close,
  view,
}: {
  results: OrganizationInviteResult[];
  pending: boolean;
  finished: boolean;
  retry: boolean;
  disabled: boolean;
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
          <Button type="submit" variant="primary" disabled={disabled}>
            {pending ? "Sending…" : sendLabel}
          </Button>
        </>
      )}
    </div>
  );
}

function inviteTitle(name: string, finished: boolean, results: OrganizationInviteResult[]) {
  if (!finished) return `Invite people to ${name}`;
  return results.every((result) => invitationOutcome(result) === "Sent") ? "Invitations sent" : "Invitations";
}
