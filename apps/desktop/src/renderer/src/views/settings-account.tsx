import { billingMoves, cloudTime, hoursDetail, periodLabel, planDate, type BillingMove } from "@openorc/client";
import { payBlock, PRO_PERIODS, sendBlockWords, type AccountStatus, type BillingOffers, type BillingPage, type ProPeriod } from "@openorc/protocol";
import { useEffect, useState } from "react";
import { Button, Segmented, TextButton, Tooltip } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { Failure } from "./settings-secret-field";
import { LoadError, Section, SettingRow, Status } from "./settings-shared";

type SignedOut = Extract<AccountStatus, { state: "signed-out" }>;
type SignedIn = Extract<AccountStatus, { state: "signed-in" }>;

/** Settings > Account. Everything shown is `account.status`, which the core keeps and announces, so every window agrees. */
export function AccountSettings({ active }: { active: boolean }) {
  const status = useRpc("account.status", {}, { enabled: active });
  if (status.isError) return <LoadError retry={() => void status.refetch()} />;
  if (!status.data || status.data.state === "unavailable") return null;
  return status.data.state === "signed-in" ? <SignedInAccount account={status.data} active={active} /> : <SignIn status={status.data} />;
}

/**
 * Sign in opens OpenOrc's sign-in page in the browser, which hands back to the app. While the page waits it can be
 * opened again or the sign-in called off; one that did not finish says why.
 */
function SignIn({ status }: { status: SignedOut }) {
  const signIn = useRpcMutation("account.signIn");
  const cancel = useRpcMutation("account.signIn.cancel");
  const waiting = status.signingIn?.state === "waiting";
  const failed = status.signingIn?.state === "failed" ? status.signingIn.error : status.error;
  const endedHint = status.ended ? "Your session ended" : undefined;
  return (
    <Section title="OpenOrc account">
      <SettingRow label={waiting ? "Signing in" : "Not signed in"} hint={waiting ? "Continue in your browser" : endedHint}>
        {waiting ? (
          <TextButton tone="muted" disabled={cancel.isPending} onClick={() => cancel.mutate({})}>
            Cancel
          </TextButton>
        ) : null}
        <Button size="sm" variant={waiting ? "secondary" : "primary"} disabled={signIn.isPending} onClick={() => signIn.mutate({})}>
          {waiting ? "Open again" : "Sign in"}
        </Button>
      </SettingRow>
      <Failure error={signIn.error ?? cancel.error ?? (failed ? new Error(failed) : null)} />
    </Section>
  );
}

/** Who is signed in, what they have and the ways to pay, and whether OpenOrc Cloud answers now, with Sign out beside the name. */
function SignedInAccount({ account, active }: { account: SignedIn; active: boolean }) {
  const signOut = useRpcMutation("account.signOut");
  const open = useRpcMutation("account.billing.open");
  const live = account.reach === "live";
  return (
    <Section
      title={account.name ?? account.email}
      description={account.name ? account.email : undefined}
      actions={
        <Button size="sm" disabled={signOut.isPending} onClick={() => signOut.mutate({})}>
          Sign out
        </Button>
      }
    >
      <PlanRows account={account} active={active} opening={open.isPending} onOpen={(page) => open.mutate(page)} />
      <SettingRow label="OpenOrc Cloud">
        <Status ok={live}>{live ? "Connected" : "Can't be reached"}</Status>
      </SettingRow>
      <Failure error={open.error ?? signOut.error ?? (account.error ? new Error(account.error) : null)} />
    </Section>
  );
}

/**
 * The plan and the hours, each row ending in its way to pay. The one that fixes what the account lacks is the column's
 * ink pill, so a person sent here to upgrade, buy hours or fix a payment lands on that move. A page opened to pay is
 * watched by the core until its purchase lands or the person leaves this screen.
 */
function PlanRows({ account, active, opening, onOpen }: { account: SignedIn; active: boolean; opening: boolean; onOpen: (page: BillingPage) => void }) {
  const [period, setPeriod] = useState<ProPeriod>("monthly");
  useLeaveBilling(active && account.paying !== null);
  // Asked again on each visit to this screen; a price missing or not read shows none and blocks nothing.
  const offers = useRpc("account.offers", {}, { enabled: active, staleTime: 0 }).data ?? null;
  const moves = billingMoves(account, offers);
  const periods = PRO_PERIODS.map((value) => ({ value, label: periodLabel(value, offers?.pro.find((offer) => offer.period === value)?.price ?? null) }));
  const waiting = (page: BillingPage["page"]) => (account.paying?.page === page && page !== "billing" ? "Waiting for your payment" : null);
  const move = (each: BillingMove, page: BillingPage) => <BillingButton move={each} pending={opening} onClick={() => onOpen(page)} />;
  return (
    <>
      <SettingRow label="Plan" hint={waiting("pro") ?? planHint(account, offers)}>
        <Status ok={account.plan.pro && account.plan.standing !== "grace"}>{account.plan.pro ? "Pro" : "Free"}</Status>
        {moves.plan.page === "pro" ? <Segmented size="sm" label="Pay" value={period} options={periods} onChange={setPeriod} /> : null}
        {move(moves.plan.page === "pro" ? { ...moves.plan, label: "Upgrade to Pro" } : moves.plan, moves.plan.page === "pro" ? { page: "pro", period } : { page: "billing" })}
      </SettingRow>
      {account.hours ? (
        <SettingRow label="Cloud hours" hint={waiting("hours") ?? (hoursDetail(account.hours) || undefined)}>
          <span className="tabular">{cloudTime(account.hours.leftSeconds)} left</span>
          {moves.hours ? move(moves.hours, { page: "hours" }) : null}
        </SettingRow>
      ) : null}
    </>
  );
}

/** The included allowance on Free, otherwise when Pro renews or needs a payment. */
function planHint(account: SignedIn, offers: BillingOffers | null): string | undefined {
  if (!account.plan.pro) return offers?.monthlySeconds ? `Pro includes ${offers.monthlySeconds / 3600} cloud hours a month.` : undefined;
  const unpaid = account.plan.pro && account.plan.standing === "live" && payBlock(account) === "awaiting_payment";
  return (unpaid ? sendBlockWords("awaiting_payment", "") : planDate(account.plan)) ?? undefined;
}

/** A way to pay; one that cannot be made now is disabled and says why on demand. */
function BillingButton({ move, pending, onClick }: { move: BillingMove; pending: boolean; onClick: () => void }) {
  const button = (
    <Button size="sm" variant={move.primary ? "primary" : "secondary"} disabled={pending || move.blocked !== null} onClick={onClick}>
      {move.label}
    </Button>
  );
  return move.blocked ? <Tooltip label={move.blocked}>{button}</Tooltip> : button;
}

/** While a page opened to pay is watched, leaving this screen (another section, or out of Settings) stops the watch. */
function useLeaveBilling(watching: boolean) {
  const { mutate } = useRpcMutation("account.billing.leave");
  useEffect(() => {
    if (!watching) return;
    return () => mutate({});
  }, [watching, mutate]);
}
