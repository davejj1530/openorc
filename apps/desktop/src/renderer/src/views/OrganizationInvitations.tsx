import { useEffect, useRef, useState } from "react";
import type { OrganizationInvitation } from "@openorc/protocol";
import { Button, Dialog, Tooltip } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { cn } from "../lib/cn";
import { useRouter } from "../lib/router";
import { OrganizationInvitationMenu } from "./OrganizationInvitationMenu";

export function OrganizationInvitations({ spaceId }: { spaceId: string }) {
  const read = useRpc("organization.invitations", { spaceId });
  const now = useInvitationClock(read.data ?? []);
  const section = useRef<HTMLElement>(null);
  const route = useRouter((state) => state.route);
  const scrolled = useRef<typeof route | null>(null);
  const [revoking, setRevoking] = useState<{ invitation: OrganizationInvitation; trigger: HTMLButtonElement | null } | null>(null);
  const close = () => {
    const trigger = revoking?.trigger;
    setRevoking(null);
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  };
  useEffect(() => {
    if (scrolled.current === route || route.view !== "people" || route.spaceId !== spaceId || route.section !== "invitations" || !read.data?.length) return;
    section.current?.scrollIntoView({ block: "nearest" });
    scrolled.current = route;
  }, [route, spaceId, read.data]);
  if (!read.data?.length && !read.error) return null;
  return (
    <section ref={section} className="people-invitations" aria-label="Invitations">
      <h2>Invitations</h2>
      {read.data?.map((invitation) => (
        <InvitationRow key={invitation.id} invitation={invitation} spaceId={spaceId} now={now} disabled={Boolean(read.error)} revoke={(trigger) => setRevoking({ invitation, trigger })} />
      ))}
      {read.error ? (
        <div className="people-read-state">
          <p className="organization-error" role="alert">
            {read.error.message}
          </p>
          <Button onClick={() => void read.refetch()}>Try again</Button>
        </div>
      ) : null}
      {revoking ? <RevokeInvitation spaceId={spaceId} invitation={revoking.invitation} close={close} /> : null}
    </section>
  );
}

function InvitationRow({
  invitation,
  spaceId,
  now,
  disabled,
  revoke,
}: {
  invitation: OrganizationInvitation;
  spaceId: string;
  now: number;
  disabled: boolean;
  revoke(trigger: HTMLButtonElement | null): void;
}) {
  const resend = useRpcMutation("organization.invitation.resend");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [copied]);
  const resendDisabled = disabled || resend.isPending || invitation.resendAt > now;
  const cooldown = resendReason(invitation.resendAt, now);
  const showResend = invitation.delivery?.status === "sent" || invitation.state === "expired" || invitation.expiresAt <= now;
  const send = () => resend.mutate({ spaceId, invitationId: invitation.id });
  const copy = () => {
    setCopyError(null);
    void navigator.clipboard.writeText(invitation.url).then(
      () => setCopied(true),
      () => setCopyError("The link couldn't be copied. Try again."),
    );
  };
  return (
    <div>
      <div className="people-invitation-row">
        <InvitationIdentity invitation={invitation} now={now} />
        {showResend ? (
          <Tooltip label={cooldown}>
            <Button size="sm" disabled={resendDisabled} onClick={send}>
              {resend.isPending ? "Sending…" : "Resend"}
            </Button>
          </Tooltip>
        ) : (
          <Button size="sm" onClick={copy} disabled={disabled}>
            {copied ? "Copied" : "Copy link"}
          </Button>
        )}
        <OrganizationInvitationMenu
          email={invitation.email}
          disabled={disabled || resend.isPending}
          resendDisabled={resendDisabled}
          resendReason={cooldown}
          offerResend={!showResend}
          copy={copy}
          resend={send}
          revoke={revoke}
        />
      </div>
      {resend.error || copyError ? (
        <p className="organization-error people-row-error" role="alert">
          {resend.error?.message ?? copyError}
        </p>
      ) : null}
    </div>
  );
}

function RevokeInvitation({ invitation, spaceId, close }: { invitation: OrganizationInvitation; spaceId: string; close(): void }) {
  const revoke = useRpcMutation("organization.invitation.revoke");
  return (
    <Dialog
      open
      title="Revoke invitation?"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      width={420}
    >
      <div className="organization-form">
        <p className="text-ink-3">{invitation.email} won't be able to join with this invitation.</p>
        {revoke.error ? (
          <p className="organization-error" role="alert">
            {revoke.error.message}
          </p>
        ) : null}
        <div className="organization-actions">
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={revoke.isPending} onClick={() => revoke.mutate({ spaceId, invitationId: invitation.id }, { onSuccess: close })}>
            {revoke.isPending ? "Revoking…" : "Revoke invitation"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function useInvitationClock(invitations: OrganizationInvitation[]): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const deadlines = invitations
      .flatMap((invite) => [invite.expiresAt, invite.resendAt])
      .map((at) => at - now)
      .filter((left) => left > 0);
    const timer = setTimeout(() => setNow(Date.now()), Math.min(60_000, ...deadlines) + 1);
    return () => clearTimeout(timer);
  }, [invitations, now]);
  return now;
}

function sentAgo(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (!minutes) return "just now";
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (minutes < 60) return format.format(-minutes, "minute");
  if (minutes < 1440) return format.format(-Math.floor(minutes / 60), "hour");
  return format.format(-Math.floor(minutes / 1440), "day");
}

function InvitationIdentity({ invitation, now }: { invitation: OrganizationInvitation; now: number }) {
  const expired = invitation.state === "expired" || invitation.expiresAt <= now;
  const failed = invitation.delivery?.status === "failed";
  const role = invitation.role === "admin" ? "Admin" : "Member";
  let detail = `${role} · Not emailed`;
  if (expired) detail = `${role} · Expired`;
  else if (failed) detail = "Email wasn't sent";
  else if (invitation.delivery?.status === "sent") detail = `${role} · Sent ${sentAgo(invitation.delivery.at, now)}`;
  return (
    <div className="people-invitation-identity">
      <span>{invitation.email}</span>
      <span className={cn("organization-small", failed && !expired && "organization-error")}>{detail}</span>
      {failed && invitation.delivery?.reason ? <span className="organization-small">{invitation.delivery.reason}</span> : null}
    </div>
  );
}
function resendReason(at: number, now: number) {
  const minutes = Math.ceil((at - now) / 60000);
  return minutes > 0 ? `Send again in ${minutes} minute${minutes === 1 ? "" : "s"}.` : undefined;
}
