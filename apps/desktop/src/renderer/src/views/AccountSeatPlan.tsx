import { allowanceSourceWords, formatUsageTime, periodLabel, planDate, seatDeadline, type BillingMove } from "@openorc/client";
import { payBlock, PRO_PERIODS, sendBlockWords, type AccountStatus, type BillingOffers, type BillingPage, type OrganizationAccess, type ProPeriod, type SpacesStatus } from "@openorc/protocol";
import { useState } from "react";
import { Button, Segmented, TextButton, Tooltip } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { SettingRow, Status } from "./settings-shared";

type SignedIn = Extract<AccountStatus, { state: "signed-in" }>;
export type PaymentControls = { opening: boolean; onOpen: (page: BillingPage) => void };

export function AccountSeatPlan({ account, offers, move, ...controls }: { account: SignedIn; offers: BillingOffers | null; move: BillingMove } & PaymentControls) {
  const [chosen, setChosen] = useState<ProPeriod>("monthly");
  const [buying, setBuying] = useState(false);
  const waiting = account.paying?.page === "pro" ? account.paying : null;
  const covered = account.allowanceSource?.kind === "organization";
  const purchasing = personalPurchase(account, move, buying);
  const period = waiting?.period ?? chosen;
  const periods = PRO_PERIODS.map((value) => ({
    value,
    label: periodLabel(value, offers?.pro.find((offer) => offer.period === value)?.price ?? null),
    disabled: controls.opening || waiting !== null,
    reason: "Stop waiting to choose another plan.",
  }));
  const purchase: BillingMove = purchasing ? { ...move, page: "pro", label: "Upgrade to Pro", primary: true } : move;
  const page: BillingPage = purchasing ? { page: "pro", period } : { page: "billing" };
  return (
    <SettingRow label="Plan" hint={waiting ? "Waiting for your payment" : <PlanHint account={account} offers={offers} />}>
      {account.organizationAccess?.state !== "grace" ? <Status ok={account.plan.pro && account.plan.standing !== "grace"}>{account.plan.pro ? "Pro" : "Free"}</Status> : null}
      {purchasing ? <Segmented size="sm" label="Pay" value={period} options={periods} onChange={setChosen} /> : null}
      {covered && !purchasing ? (
        <Button size="sm" onClick={() => setBuying(true)}>
          Pay for Pro yourself
        </Button>
      ) : (
        <PaymentAction move={purchase} page={page} waiting={waiting !== null} {...controls} />
      )}
    </SettingRow>
  );
}

function personalPurchase(account: SignedIn, move: BillingMove, buying: boolean): boolean {
  if (move.page === "pro" || account.paying?.page === "pro") return true;
  if (account.paidBy === "organization" && account.organizationAccess?.state === "grace") return true;
  return account.allowanceSource?.kind === "organization" && buying;
}

function PlanHint({ account, offers }: { account: SignedIn; offers: BillingOffers | null }) {
  const spaces = useRpc("spaces.status", {}, { enabled: account.organizationAccess?.reason === "no_pro" }).data;
  const access = privatePlanAccess(account.organizationAccess, spaces);
  if (access && access.state !== "active")
    return (
      <>
        {access.message}
        {access.state === "grace" ? (
          <span className="mt-1.5 block text-ink" data-tip={formatUsageTime(access.until)}>
            Until {seatDeadline(access.until)}
          </span>
        ) : null}
      </>
    );
  const source = allowanceSourceWords(account.allowanceSource);
  if (source)
    return (
      <>
        {source}
        {account.allowanceSource?.kind === "self" ? ` · ${planDate(account.plan) ?? ""}` : null}
      </>
    );
  if (!account.plan.pro) return offers?.monthlySeconds ? <>Pro includes {offers.monthlySeconds / 3600} cloud hours a month.</> : null;
  const unpaid = account.plan.standing === "live" && payBlock(account) === "awaiting_payment";
  return <>{unpaid ? sendBlockWords("awaiting_payment", "") : planDate(account.plan)}</>;
}

function privatePlanAccess(access: OrganizationAccess | undefined, spaces: SpacesStatus | undefined): OrganizationAccess | undefined {
  if (access?.reason !== "no_pro") return access;
  return spaces?.state === "ready" && spaces.spaces.some((space) => space.kind === "organization") ? access : undefined;
}

/** A waiting checkout opens again at the same address, or can be left without canceling the payment. */
export function PaymentAction({ move, page, waiting, opening, onOpen }: { move: BillingMove; page: BillingPage; waiting: boolean } & PaymentControls) {
  const leave = useRpcMutation("account.billing.leave");
  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      {waiting ? (
        <TextButton tone="muted" disabled={leave.isPending} onClick={() => leave.mutate({})}>
          Stop waiting
        </TextButton>
      ) : null}
      <BillingButton move={waiting ? { ...move, label: "Open again", blocked: null } : move} pending={opening} onClick={() => onOpen(page)} />
    </span>
  );
}

function BillingButton({ move, pending, onClick }: { move: BillingMove; pending: boolean; onClick: () => void }) {
  const button = (
    <Button size="sm" variant={move.primary ? "primary" : "secondary"} disabled={pending || move.blocked !== null} onClick={onClick}>
      {move.label}
    </Button>
  );
  return move.blocked ? <Tooltip label={move.blocked}>{button}</Tooltip> : button;
}
