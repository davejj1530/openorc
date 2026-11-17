import type { AccountDeletion } from "@openorc/protocol";
import { useState } from "react";
import { Button, Dialog, Input, TextButton } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { useRouter } from "../lib/router";
import "../components/Organization.css";

/**
 * Deleting the OpenOrc account, for good: what goes with it, one to a line, as the server reads it now; the address
 * typed out; then the code just emailed to it. An organization that holds the deletion says why, with the way to its
 * people, and nothing can be sent. Once the server takes it this app is signed out, and the dialog closes with it.
 */
export function AccountDeletionDialog({ onClose }: { onClose(): void }) {
  const plan = useRpc("account.deletion", {}, { staleTime: 0 });
  const code = useRpcMutation("account.deletion.code");
  const destroy = useRpcMutation("account.delete");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const pending = code.isPending || destroy.isPending;
  const data = plan.data;
  const held = data ? data.held.length > 0 : false;
  const typed = data ? email.trim().toLowerCase() === data.email.toLowerCase() : false;
  const sent = code.isSuccess;
  const failed = destroy.error ?? code.error;
  return (
    <Dialog
      open
      title="Delete your account?"
      width={460}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <form
        className="organization-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!data || held || !typed) return;
          if (!sent) code.mutate({});
          else if (otp.length === 6) destroy.mutate({ email, otp }, { onSuccess: onClose });
        }}
      >
        {data ? <Consequences plan={data} onOpen={onClose} /> : <p className="organization-membership-detail">{plan.isError ? plan.error.message : "Reading what goes with it…"}</p>}
        {data && !held ? (
          <>
            <label className="organization-label">
              Type {data.email} to confirm
              <Input variant="sheet" aria-label={`Type ${data.email} to confirm`} value={email} onChange={(event) => setEmail(event.target.value)} disabled={pending || sent} autoFocus />
            </label>
            {sent ? (
              <label className="organization-label">
                Code sent to {data.email}
                <Input
                  variant="sheet"
                  aria-label="Code from your email"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={otp}
                  onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  disabled={destroy.isPending}
                  autoFocus
                />
              </label>
            ) : null}
          </>
        ) : null}
        {failed ? (
          <p role="alert" className="organization-error">
            {failed.message}
          </p>
        ) : null}
        <div className="organization-actions">
          {sent ? (
            <TextButton type="button" tone="muted" className="mr-auto" disabled={pending} onClick={() => code.mutate({})}>
              Send again
            </TextButton>
          ) : null}
          <Button disabled={pending} onClick={onClose}>
            {held ? "Close" : "Cancel"}
          </Button>
          {held ? null : <Submit sent={sent} sending={code.isPending} deleting={destroy.isPending} ready={!pending && typed && (!sent || otp.length === 6)} />}
        </div>
      </form>
    </Dialog>
  );
}

const SUBMIT = { code: { idle: "Send code", working: "Sending…" }, delete: { idle: "Delete account", working: "Deleting…" } } as const;

/** Send code, then Delete account once the code has gone out. */
function Submit({ sent, sending, deleting, ready }: { sent: boolean; sending: boolean; deleting: boolean; ready: boolean }) {
  const words = sent ? SUBMIT.delete : SUBMIT.code;
  return (
    <Button type="submit" variant="danger" disabled={!ready}>
      {(sent ? deleting : sending) ? words.working : words.idle}
    </Button>
  );
}

/** The line a person's own Pro gets: paid for, it ends without a refund. */
const PRO_LINE = { paid: "Your Pro, ending now without a refund", given: "Your Pro" } as const;

/** What goes, one to a line, or, while an organization holds it, only why and where that changes. */
function Consequences({ plan, onOpen }: { plan: AccountDeletion; onOpen(): void }) {
  if (plan.held.length) {
    return (
      <ul className="flex flex-col gap-3">
        {plan.held.map((organization) => (
          <li key={organization.id} className="flex items-start justify-between gap-3">
            <span className="organization-membership-detail">{organization.reason}</span>
            <Button size="sm" onClick={() => (onOpen(), useRouter.getState().navigate({ view: "people", spaceId: organization.id }))}>
              Open {organization.name}
            </Button>
          </li>
        ))}
      </ul>
    );
  }
  const lines = [
    "Your Personal space, its cloud threads, projects and saved work",
    ...plan.deleted.map((organization) => (organization.seats ? `${organization.name} and everything in it, its seats ending without a refund` : `${organization.name} and everything in it`)),
    ...plan.left.map((organization) => `Your place in ${organization.name}`),
    ...(plan.pro ? [PRO_LINE[plan.pro]] : []),
    "Your cloud sign-ins, connectors, skills and machines",
  ];
  return (
    <div className="flex flex-col gap-3">
      <ul className="organization-membership-detail flex list-disc flex-col gap-1 pl-5">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="organization-membership-detail">This can't be undone. Threads on this Mac stay.</p>
    </div>
  );
}
