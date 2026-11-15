import { useState } from "react";
import type { OrganizationRole } from "@openorc/protocol";
import { keepInvitationDraft, takeInvitationDraft } from "./invitation-draft";
import { useInvitationSeatInventory, type InvitationSeatInventory } from "./invitation-seat-inventory";
import { chooseInvitationSeats, type InvitationSeatChoice } from "./invitation-seats";
import { invitationAddresses, useInvitationBatch, type InvitationSent } from "./organization-invitations";

/** The addresses still to send: the refused ones on a retry, else every address written. */
function sending(results: readonly InvitationSent[], emails: string[]) {
  const refused = results.filter((result) => result.state === "refused").map((result) => result.email);
  const settled = new Set(results.filter((result) => result.state !== "refused").map((result) => result.email));
  return { refused, targets: refused.length ? refused : emails, settled };
}

/** A frozen admin may invite only with a seat, so nothing goes out while an address has none. */
const lacksSeat = (inventory: InvitationSeatInventory | null, choice: InvitationSeatChoice | null, targets: readonly string[]): boolean =>
  Boolean(inventory?.frozen && choice && targets.some((email) => choice.seats[email] === undefined));

/**
 * The invite form's draft: the addresses, the role, each address's Seat switch and the seat it would hold. A seat stays
 * with its address through a retry while it is still free. The draft is kept only when the admin leaves to buy seats.
 */
export function useInviteForm(spaceId: string, onBuySeats: (() => void) | undefined) {
  const [draft] = useState(() => takeInvitationDraft(spaceId));
  const [text, setText] = useState(draft?.text ?? "");
  const [role, setRole] = useState<OrganizationRole>(draft?.role ?? "member");
  const [switched, setSwitched] = useState<Record<string, boolean>>(draft?.switched ?? {});
  const [kept, setKept] = useState<Record<string, string>>({});
  const batch = useInvitationBatch(spaceId);
  const inventory = useInvitationSeatInventory(spaceId);
  const addresses = invitationAddresses(text);
  const { refused, targets, settled } = sending(batch.results, addresses.emails);
  const unsent = addresses.emails.filter((email) => !settled.has(email) && !addresses.invalid.includes(email));
  const choice = inventory ? chooseInvitationSeats({ addresses: unsent, wants: (email) => switched[email] ?? inventory.frozen, seats: inventory.seats, kept }) : null;
  return {
    text,
    role,
    setRole,
    addresses,
    batch,
    retry: refused.length > 0,
    /** The addresses that show a Seat switch, with the seats they would hold; null where the form says nothing of seats. */
    seats: choice && unsent.length ? { addresses: unsent, choice } : null,
    needsSeat: lacksSeat(inventory, choice, targets),
    edit(next: string) {
      setText(next);
      batch.reset();
    },
    switchSeat(email: string, on: boolean) {
      if (choice) setKept(choice.seats);
      setSwitched((before) => ({ ...before, [email]: on }));
    },
    send() {
      setKept(choice?.seats ?? {});
      void batch.send(targets, role, choice?.seats);
    },
    buySeats() {
      keepInvitationDraft(spaceId, { text, role, switched });
      batch.cancel();
      onBuySeats?.();
    },
  };
}
