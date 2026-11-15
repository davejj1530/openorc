import type { OrganizationDeleteResult } from "@openorc/protocol";
import { accountDay } from "@openorc/client";
import { Button } from "./ui";

export type DeleteRefusal = NonNullable<OrganizationDeleteResult["refusal"]>;

/**
 * The server's sentence for a deletion its billing refuses. The sentence names the day the seats end as that
 * instant's UTC date; here the same instant is written the way every other day in the app is.
 */
export function deleteRefusalWords({ message, endsAt }: DeleteRefusal): string {
  return endsAt === null ? message : message.replaceAll(new Date(endsAt).toISOString().slice(0, 10), accountDay(endsAt));
}

/** In place of Delete: the organization cannot be deleted until its seats allow it, and Seats is where that changes. */
export function OrganizationDeleteBillingRefusal({ onManageSeats }: { onManageSeats(): void }) {
  return (
    <Button variant="primary" onClick={onManageSeats}>
      Manage seats
    </Button>
  );
}
