import { useEffect, useState } from "react";
import type { OrganizationBilling, SeatQuantityWork } from "@openorc/protocol";
import { accountDay, formatUsageTime } from "@openorc/client";
import { Button } from "../components/ui";
import { ChangeSeatsDialog } from "../dialogs/ChangeSeatsDialog";
import { useSeatQuantity, type SeatQuantityTransport } from "../lib/seat-quantity-scope";

type Subscription = NonNullable<OrganizationBilling["subscription"]>;
/** How the change dialog was opened: on the number, on the server's review of the number now, or on a journaled change. */
export type ChangeSeatsOpening = { from: "number" } | { from: "keep" } | { from: "work"; work: SeatQuantityWork };

const unsettled = (work: SeatQuantityWork | undefined): boolean => Boolean(work && (work.operation === null || work.operation.state === "pending"));
/** Why the number cannot be changed right now; null when it can. */
export const changeSeatsReason = (work: SeatQuantityWork | undefined, error: string | null): string | null => (unsettled(work) ? "Updating seats." : error);

/** The organization's one ink key once it has seats. */
export function ChangeSeatsButton({ reason, onClick }: { reason: string | null; onClick(): void }) {
  return (
    <Button variant="primary" disabled={reason !== null} data-tip={reason ?? undefined} onClick={onClick}>
      Change seats
    </Button>
  );
}

interface StatusProps {
  subscription: Subscription;
  work: SeatQuantityWork | undefined;
  onOpen(opening: ChangeSeatsOpening): void;
  onManageBilling(): void;
  /** Reads what became of a change; never sends one. */
  onRead(id: string): void;
}

/** What is still to be known or decided about the number of seats, below the summary. */
export function SeatQuantityStatus({ subscription, work, onOpen, onManageBilling, onRead }: StatusProps) {
  if (work) return <ChangeStatus work={work} onOpen={onOpen} onManageBilling={onManageBilling} onRead={onRead} />;
  const scheduled = scheduledWords(subscription);
  if (!scheduled) return null;
  return (
    <div className="seats-inline-state">
      <span data-tip={formatUsageTime(scheduled.at)}>{scheduled.words}</span>
      <Button onClick={() => onOpen({ from: "keep" })}>Keep current seats</Button>
    </div>
  );
}

function ChangeStatus({ work, onOpen, onManageBilling, onRead }: Omit<StatusProps, "subscription"> & { work: SeatQuantityWork }) {
  if (unsettled(work))
    return (
      <div className="seats-inline-state">
        <Button className="seats-operation-status" variant="ghost" aria-label="View seat change" onClick={() => onOpen({ from: "work", work })}>
          Updating seats.
        </Button>
      </div>
    );
  if (work.operation?.state === "failed")
    return (
      <div className="seats-inline-state">
        <span className="seats-error" role="alert">
          {work.operation.message ?? work.error}
        </span>
        <Button onClick={onManageBilling}>Manage billing</Button>
      </div>
    );
  return (
    <div className="seats-inline-state">
      <span>
        Seats updated.{" "}
        <span className="seats-error" role="alert">
          {work.error}
        </span>
      </span>
      <Button onClick={() => onRead(work.request.body.id)}>Try again</Button>
    </div>
  );
}

function scheduledWords(subscription: Subscription): { words: string; at: number } | null {
  const at = subscription.pendingQuantity?.at ?? subscription.paidUntil;
  if (at === null) return null;
  if (subscription.standing === "ending") return { words: `All ${subscription.quantity} ${subscription.quantity === 1 ? "seat" : "seats"} end on ${accountDay(at)}.`, at };
  const next = subscription.pendingQuantity?.quantity;
  return next ? { words: `${next} ${next === 1 ? "seat" : "seats"} from ${accountDay(at)}.`, at } : null;
}

/** The change dialog with a flow of its own, alive only while it is open. */
export function ChangeSeatsFlow({
  spaceId,
  billing,
  opening,
  transport,
  onClose,
  onManageBilling,
}: {
  spaceId: string;
  billing: OrganizationBilling;
  opening: ChangeSeatsOpening;
  transport: SeatQuantityTransport;
  onClose(): void;
  onManageBilling(): void;
}) {
  const view = useSeatQuantity(spaceId, transport);
  const [started, setStarted] = useState(false);
  const quantity = billing.subscription?.quantity;
  useEffect(() => {
    if (!view || started) return;
    setStarted(true);
    if (opening.from === "work") view.resume(opening.work);
    else if (opening.from === "keep" && quantity !== undefined) {
      view.select(quantity);
      void view.review();
    }
  }, [view, started, opening, quantity]);
  return view && started ? <ChangeSeatsDialog view={view} billing={billing} onClose={onClose} onManageBilling={onManageBilling} /> : null;
}
