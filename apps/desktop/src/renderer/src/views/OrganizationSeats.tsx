import type { OrganizationBilling, OrganizationPayment } from "@openorc/protocol";
import { accountDay, formatUsageTime } from "@openorc/client";
import { useState, useSyncExternalStore } from "react";
import { Button, Tooltip } from "../components/ui";
import { BuySeatsDialog, type BuySeatsDialogProps } from "../dialogs/BuySeatsDialog";
import type { OrganizationBillingView, OrganizationBillingViewState } from "../lib/organization-billing-state";
import { SeatInventory } from "./SeatInventory";
import "./organization-seats.css";

interface Props {
  spaceId: string;
  view: OrganizationBillingView;
  offers: BuySeatsDialogProps["offers"];
}

export function OrganizationSeats({ spaceId, view, offers }: Props) {
  const state = useSyncExternalStore(view.subscribe, view.getSnapshot);
  const [buying, setBuying] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const billing = state.status?.billing;
  const payment = state.status?.payment ?? null;
  const error = state.error ?? payment?.error;
  const formOpen = buying && Boolean(billing) && !purchaseFinished(state);
  const buy = () => {
    if (payment?.state === "pending") void view.open(payment.target);
    else {
      setSubmitted(false);
      setBuying(true);
    }
  };
  return (
    <>
      {billing ? <SeatSummary billing={billing} state={state} buy={buy} manage={() => void view.open({ page: "billing" })} /> : null}
      {!billing && state.loading ? <p className="seats-inline-state text-ink-3">Loading seats…</p> : null}
      {!formOpen ? <SeatPaymentState state={state} view={view} /> : null}
      {billing?.subscription?.overallocated ? <p className="seats-inline-state">More people hold seats than are paid for. Take back a seat or add seats.</p> : null}
      {billing && billing.seats.length > 0 ? <SeatInventory seats={billing.seats} /> : null}
      {formOpen ? (
        <BuySeatsDialog
          spaceId={spaceId}
          opening={state.opening || state.uncertain}
          submitted={submitted && payment?.state !== "failed"}
          error={error}
          offers={offers}
          onClose={() => setBuying(false)}
          onBuy={(target) => {
            setSubmitted(true);
            void buySeats(view, target, () => setBuying(false));
          }}
        />
      ) : null}
    </>
  );
}

async function buySeats(view: OrganizationBillingView, target: Parameters<OrganizationBillingView["open"]>[0], close: () => void) {
  await view.open(target);
  const state = view.getSnapshot();
  const outcome = state.status?.payment?.state;
  if (!state.uncertain && !state.error && !state.status?.payment?.error && outcome && outcome !== "failed") close();
}

function SeatSummary({ billing, state, buy, manage }: { billing: OrganizationBilling; state: OrganizationBillingViewState; buy(): void; manage(): void }) {
  const subscription = billing.subscription;
  const hasSubscription = subscription !== null && subscription.standing !== "ended";
  const payment = state.status?.payment;
  const waiting = payment?.target.page === "checkout" && payment.watching;
  const complete = purchaseFinished(state);
  const disabled = state.opening || state.uncertain || Boolean(state.error) || Boolean(waiting);
  if (complete && !subscription) return null;
  return (
    <section className="seats-summary">
      <div>
        <h2>{seatSummaryTitle(billing)}</h2>
        {subscription ? <SeatRenewal subscription={subscription} /> : null}
      </div>
      <div className="seats-summary-actions">
        {subscription ? (
          <Button disabled={state.opening || state.uncertain} onClick={manage}>
            Manage billing
          </Button>
        ) : null}
        {!hasSubscription && !complete ? <SeatBuyButton disabled={disabled} reason={state.error ?? "The payment is still being checked."} buy={buy} /> : null}
      </div>
    </section>
  );
}

function seatSummaryTitle({ subscription, available }: OrganizationBilling): string {
  if (!subscription || subscription.standing === "ended") return "No seats";
  return `${subscription.quantity} ${subscription.quantity === 1 ? "seat" : "seats"} · ${available} available`;
}

function purchaseFinished(state: OrganizationBillingViewState): boolean {
  return state.status?.payment?.state === "complete" && state.status.billing?.subscription?.standing !== "ended";
}

function SeatBuyButton({ disabled, reason, buy }: { disabled: boolean; reason: string; buy(): void }) {
  const button = (
    <Button variant="primary" disabled={disabled} onClick={buy}>
      Buy seats
    </Button>
  );
  return disabled ? (
    <Tooltip label={reason} render={<span className="inline-flex" tabIndex={0} />}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}

function SeatPaymentState({ state, view }: { state: OrganizationBillingViewState; view: OrganizationBillingView }) {
  const payment = state.status?.payment;
  const error = state.error ?? payment?.error;
  const waiting = payment?.target.page === "checkout" && payment.watching && (payment.state === "waiting" || payment.state === "pending");
  return (
    <>
      {waiting ? <SeatPaymentWaiting payment={payment} view={view} opening={state.opening} /> : null}
      {payment?.state === "complete" && !state.status?.billing?.subscription ? <p className="seats-inline-state">{payment.target.page === "checkout" ? "Seats bought." : "Billing updated."}</p> : null}
      {error ? (
        <div className="seats-inline-state">
          <span className="seats-error" role="alert">
            {error}
          </span>
          <Button disabled={state.loading} onClick={() => void view.refresh()}>
            Try again
          </Button>
        </div>
      ) : null}
    </>
  );
}

function SeatRenewal({ subscription }: { subscription: NonNullable<OrganizationBilling["subscription"]> }) {
  if (subscription.standing === "ended") return <p>Ended</p>;
  if (subscription.standing === "grace") return <p>Payment needs attention.</p>;
  const at = subscription.paidUntil;
  if (at === null) return null;
  return <p data-tip={formatUsageTime(at)}>{subscription.standing === "ending" ? `Ends ${accountDay(at)}` : `${subscription.plan === "monthly" ? "Monthly" : "Yearly"} · Renews ${accountDay(at)}`}</p>;
}

function SeatPaymentWaiting({ payment, view, opening }: { payment: OrganizationPayment; view: OrganizationBillingView; opening: boolean }) {
  return (
    <div className="seats-inline-state">
      <span>Waiting for your payment</span>
      <Button variant="ghost" onClick={() => void view.leave()}>
        Stop waiting
      </Button>
      <Button disabled={opening} onClick={() => void view.open(payment.target)}>
        Open again
      </Button>
    </div>
  );
}
