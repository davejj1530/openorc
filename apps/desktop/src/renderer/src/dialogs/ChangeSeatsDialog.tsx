import { useEffect, useState, useSyncExternalStore } from "react";
import type { OrganizationBilling, SeatQuantityPreview } from "@openorc/protocol";
import { accountDay, formatUsageTime, periodLabel, priceText } from "@openorc/client";
import { Button, Dialog, Input } from "../components/ui";
import { hoursAndMinutes, quantityChange, type QuantityChange, type SeatQuantity, type SeatQuantityState } from "../lib/seat-quantity";
import "../views/organization-seats.css";

type Subscription = NonNullable<OrganizationBilling["subscription"]>;
export interface ChangeSeatsDialogProps {
  view: SeatQuantity;
  billing: OrganizationBilling;
  onClose(): void;
  /** Opens the organization's own billing page, for a payment that needs attention. */
  onManageBilling(): void;
}

const BOUNDS = "Choose a number of seats from 0 to 100.";
const confirmWords: Record<QuantityChange, string> = { add: "Add seats", reduce: "Reduce seats", end: "End subscription", keep: "Keep current seats" };
const seats = (count: number) => `${count} ${count === 1 ? "seat" : "seats"}`;

/** One dialog from the number to the server's review to the change itself. Every amount and date shown is the server's. */
export function ChangeSeatsDialog({ view, billing, onClose, onManageBilling }: ChangeSeatsDialogProps) {
  const state = useSyncExternalStore(view.subscribe, view.getSnapshot);
  const subscription = billing.subscription;
  const settled = state.state === "complete" && !state.error;
  useEffect(() => {
    if (settled) onClose();
  }, [settled, onClose]);
  if (!subscription || settled) return null;
  return (
    <Dialog
      open
      title={title(state, billing.organization.name)}
      width={state.preview ? 480 : 440}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="seats-dialog">
        <ChangeBody state={state} view={view} billing={billing} subscription={subscription} />
        {state.error ? (
          <p className="seats-error" role="alert">
            {state.error}
          </p>
        ) : null}
        <div className="organization-actions">
          <Button onClick={onClose}>{state.work ? "Close" : "Cancel"}</Button>
          <ChangeAction state={state} view={view} subscription={subscription} onManageBilling={onManageBilling} />
        </div>
      </div>
    </Dialog>
  );
}

function ChangeBody({ state, view, billing, subscription }: { state: SeatQuantityState; view: SeatQuantity; billing: OrganizationBilling; subscription: Subscription }) {
  if (state.state === "submitting" || state.state === "pending") return <p role="status">Updating seats.</p>;
  if (state.state === "complete") return <p role="status">Seats updated.</p>;
  if (state.state === "preview" && state.preview) return <ChangeReview preview={state.preview} subscription={subscription} />;
  if (state.work) return null;
  return <SeatNumber state={state} view={view} billing={billing} subscription={subscription} />;
}

function SeatNumber({ state, view, billing, subscription }: { state: SeatQuantityState; view: SeatQuantity; billing: OrganizationBilling; subscription: Subscription }) {
  const [text, setText] = useState(() => String(state.target ?? subscription.quantity));
  const assigned = billing.seats.filter((seat) => seat.assignment.kind !== "available").length;
  const invalid = numberOf(text) === null && text.trim() !== "";
  return (
    <>
      <label className="organization-label">
        Seats
        <Input
          variant="sheet"
          type="number"
          min={0}
          max={100}
          step={1}
          aria-label="Seats"
          autoFocus
          value={text}
          disabled={state.reviewing}
          aria-invalid={invalid}
          onChange={(event) => {
            setText(event.target.value);
            view.select(numberOf(event.target.value));
          }}
        />
      </label>
      {invalid ? <p className="seats-error">{BOUNDS}</p> : null}
      <p className="text-ink-3">
        {seats(subscription.quantity)} now · {assigned} assigned
      </p>
    </>
  );
}

function ChangeReview({ preview, subscription }: { preview: SeatQuantityPreview; subscription: Subscription }) {
  const change = quantityChange(preview);
  const day = accountDay(preview.at);
  const count = { add: `${preview.from} → ${preview.to}`, reduce: `${preview.from} → ${preview.to}`, end: `${preview.from} until ${day}`, keep: String(preview.to) }[change];
  const when = { add: "After payment", reduce: day, end: day, keep: "Now" }[change];
  return (
    <>
      <dl className="seats-facts">
        <Fact label="Seats">{count}</Fact>
        <Fact label={change === "add" ? "Available" : "Takes effect"} tip={preview.effect === "renewal" ? formatUsageTime(preview.at) : undefined}>
          {when}
        </Fact>
        <Fact label="Next price">{nextPrice(preview, subscription, change)}</Fact>
        {/* An estimate is the server's and is called one; with none sent, nothing is shown in its place. */}
        {change === "add" && preview.estimatedChargeNow ? <Fact label="Estimated charge now">{priceText(preview.estimatedChargeNow)}</Fact> : null}
        {change === "add" && preview.firstGrantEndsAt !== null ? (
          <Fact label="Estimated hours per new seat" tip={formatUsageTime(preview.firstGrantEndsAt)}>
            {hoursAndMinutes(preview.firstGrantSecondsPerNewSeat)} until {accountDay(preview.firstGrantEndsAt)}
          </Fact>
        ) : null}
      </dl>
      <ChangeNote preview={preview} change={change} subscription={subscription} />
    </>
  );
}

function ChangeNote({ preview, change, subscription }: { preview: SeatQuantityPreview; change: QuantityChange; subscription: Subscription }) {
  const day = accountDay(preview.at);
  const leaving = preview.from - preview.to;
  if (change === "end") return <p>People keep these seats until {day}. Those without other Pro then have one day of grace.</p>;
  if (change === "reduce")
    return (
      <p>
        {leaving} available {leaving === 1 ? "seat ends" : "seats end"}. People and invitations holding seats keep theirs.
      </p>
    );
  if (change === "keep" && subscription.paidUntil !== null)
    return (
      <p>
        All {seats(preview.to)} renew on {accountDay(subscription.paidUntil)}.
      </p>
    );
  return null;
}

function nextPrice(preview: SeatQuantityPreview, subscription: Subscription, change: QuantityChange): string {
  if (change === "end") return "No renewal";
  return preview.nextPrice ? periodLabel(subscription.plan, preview.nextPrice) : "Price unavailable";
}

function Fact({ label, tip, children }: { label: string; tip?: string | undefined; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-tip={tip}>{children}</dd>
    </div>
  );
}

function ChangeAction({ state, view, subscription, onManageBilling }: { state: SeatQuantityState; view: SeatQuantity; subscription: Subscription; onManageBilling(): void }) {
  if (state.state === "preview" && state.preview)
    return (
      <Button variant="primary" onClick={() => void view.confirm()}>
        {confirmWords[quantityChange(state.preview)]}
      </Button>
    );
  if (state.state === "failed" && state.work) {
    const again = state.work.request.seats;
    return (
      <>
        <Button onClick={onManageBilling}>Manage billing</Button>
        <Button
          variant="primary"
          onClick={() => {
            view.select(again);
            void view.review();
          }}
        >
          Review again
        </Button>
      </>
    );
  }
  if (state.state === "draft" || state.state === "failed") {
    const unchanged = state.target === subscription.quantity && subscription.pendingQuantity === null && subscription.standing !== "ending";
    return (
      <Button variant="primary" disabled={state.reviewing || state.target === null || unchanged} onClick={() => void view.review()}>
        {state.error ? "Review again" : "Review change"}
      </Button>
    );
  }
  if ((state.state === "pending" || state.state === "complete") && state.error)
    return (
      <Button variant="primary" onClick={() => void view.retry()}>
        Try again
      </Button>
    );
  return null;
}

function title(state: SeatQuantityState, organization: string): string {
  if (state.state === "submitting" || state.state === "pending") return "Updating seats";
  if (state.state === "complete") return "Seats updated";
  if (state.state !== "preview" || !state.preview) return "Change seats";
  const { from, to } = state.preview;
  return { add: `Add ${seats(to - from)}`, reduce: `Reduce to ${seats(to)}`, end: `End ${organization}’s subscription`, keep: `Keep ${seats(to)}` }[quantityChange(state.preview)];
}

/** A whole number of seats from 0 to 100, or null for anything else. */
function numberOf(text: string): number | null {
  const value = Number(text);
  return /^\d+$/.test(text.trim()) && Number.isInteger(value) && value <= 100 ? value : null;
}
