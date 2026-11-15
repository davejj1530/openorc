import { Button } from "./ui";

/**
 * The server's three refusals of a deletion while the organization's seats are paid, ending, or still being settled.
 * Only its sentence crosses to this window, so the sentence's opening is what tells them from any other refusal.
 */
const HELD = [/^This organization still pays for seats\. /, /^This organization's seats end on /, /^This organization's billing is still being updated\. /];
export const seatsHoldDeletion = (message: string): boolean => HELD.some((opening) => opening.test(message));

/** In place of Delete: the organization cannot be deleted until its seats allow it, and Seats is where that changes. */
export function OrganizationDeleteBillingRefusal({ onManageSeats }: { onManageSeats(): void }) {
  return (
    <Button variant="primary" onClick={onManageSeats}>
      Manage seats
    </Button>
  );
}
