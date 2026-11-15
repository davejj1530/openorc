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

/** What came of one address, and whether a seat was asked for it. */
export type InvitationSent = OrganizationInviteResult & { seatAsked?: boolean };

/** Closing a batch stops the next address; an invitation already admitted stays sent. */
export function useInvitationBatch(spaceId: string) {
  const [results, setResults] = useState<InvitationSent[]>([]);
  const [pending, setPending] = useState(false);
  const ticket = useRef(0);
  const active = useRef(false);
  const cancel = () => {
    ticket.current++;
    active.current = false;
  };
  useEffect(() => cancel, []);
  /** `seats` names the seat each address is to hold; an address not named is invited without one. */
  const send = async (emails: string[], role: OrganizationRole, seats: Readonly<Record<string, string>> = {}) => {
    if (active.current) return;
    active.current = true;
    const current = ++ticket.current;
    setPending(true);
    for (const email of emails) {
      if (current !== ticket.current) return;
      let result: OrganizationInviteResult;
      try {
        const seatId = seats[email];
        const [answer] = await core.call("organization.invite", { spaceId, emails: [email], role, ...(seatId !== undefined && { seats: { [email]: seatId } }) });
        if (!answer) throw new Error("OpenOrc Cloud answered in a way this version can't read. Update OpenOrc.");
        result = answer;
      } catch (error) {
        result = { email, state: "refused", error: error instanceof Error ? error.message : "OpenOrc Cloud can't be reached." };
      }
      if (current !== ticket.current) return;
      setResults((before) => [...before.filter((row) => row.email !== email), { ...result, seatAsked: seats[email] !== undefined }]);
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
  // Pro is promised only from what the server says of the invitation now, never from the seat that was asked for.
  const pro = result.invitation?.includesSeat === true ? " · Includes Pro" : "";
  if (result.invitation?.delivery?.status === "sent") return `Sent${pro}`;
  if (result.invitation?.delivery?.status === "failed") return "Email wasn't sent";
  if (result.invitation) return `Not emailed${pro}`;
  return "Invitation created";
}

/** A seat was asked for and the invitation the server made holds none. */
export const seatNotHeld = (result: InvitationSent): boolean => result.state === "sent" && result.seatAsked === true && result.invitation !== null && result.invitation.includesSeat !== true;
