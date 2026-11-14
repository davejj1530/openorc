import { useEffect, useRef, useState } from "react";
import { InvitationEmail, type OrganizationInviteResult, type OrganizationRole } from "@openorc/protocol";
import { core } from "./rpc";

export function invitationAddresses(text: string) {
  const emails: string[] = [];
  const duplicates = new Set<string>();
  for (const email of text
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter(Boolean)) {
    if (emails.includes(email)) duplicates.add(email);
    else emails.push(email);
  }
  return { emails, duplicates: [...duplicates], invalid: emails.filter((email) => !InvitationEmail.safeParse(email).success) };
}

/** Closing a batch stops the next address; an invitation already admitted stays sent. */
export function useInvitationBatch(spaceId: string) {
  const [results, setResults] = useState<OrganizationInviteResult[]>([]);
  const [pending, setPending] = useState(false);
  const ticket = useRef(0);
  const active = useRef(false);
  const cancel = () => {
    ticket.current++;
    active.current = false;
  };
  useEffect(() => cancel, []);
  const send = async (emails: string[], role: OrganizationRole) => {
    if (active.current) return;
    active.current = true;
    const current = ++ticket.current;
    setPending(true);
    for (const email of emails) {
      if (current !== ticket.current) return;
      let result: OrganizationInviteResult;
      try {
        const [answer] = await core.call("organization.invite", { spaceId, emails: [email], role });
        if (!answer) throw new Error("OpenOrc Cloud answered in a way this version can't read. Update OpenOrc.");
        result = answer;
      } catch (error) {
        result = { email, state: "refused", error: error instanceof Error ? error.message : "OpenOrc Cloud can't be reached." };
      }
      if (current !== ticket.current) return;
      setResults((before) => [...before.filter((row) => row.email !== email), result]);
    }
    active.current = false;
    setPending(false);
  };
  return { results, pending, send, cancel, reset: () => setResults([]) };
}

export function invitationOutcome(result: OrganizationInviteResult): string {
  if (result.state !== "sent") {
    if (result.state === "already-member") return "Already a member";
    if (result.state === "already-invited") return "Already invited";
    return result.error;
  }
  if (result.invitation?.delivery?.status === "sent") return "Sent";
  if (result.invitation?.delivery?.status === "failed") return "Email wasn't sent";
  if (result.invitation) return "Not emailed";
  return "Invitation created";
}
