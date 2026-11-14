import { billingMoves, cloudTime, hoursDetail, periodLabel, planDate, type BillingMove } from "@openorc/client";
import { payBlock, PRO_PERIODS, sendBlockWords, type AccountStatus, type BillingPage, type ProPeriod } from "@openorc/protocol";
import { useEffect, useState, type KeyboardEvent } from "react";
import { Button, Input, Segmented, TextButton, Tooltip } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { Failure } from "./settings-secret-field";
import { LoadError, Section, SettingRow, Status } from "./settings-shared";

type SignedOut = Extract<AccountStatus, { state: "signed-out" }>;
type SignedIn = Extract<AccountStatus, { state: "signed-in" }>;

/** Settings > Account. Everything shown is `account.status`, which the core keeps and announces, so every window agrees. */
export function AccountSettings({ active }: { active: boolean }) {
  const status = useRpc("account.status", {}, { enabled: active });
  if (status.isError) return <LoadError retry={() => void status.refetch()} />;
  if (!status.data) return null;
  return status.data.state === "signed-in" ? <SignedInAccount account={status.data} active={active} /> : <SignIn status={status.data} />;
}

/**
 * The address, then the code. Which step shows comes from the core (`codeSentTo`), so leaving to read the email and
 * coming back lands on the code. `changing` goes back to the address until the next code is sent.
 */
function SignIn({ status }: { status: SignedOut }) {
  const send = useRpcMutation("account.sendCode");
  const signIn = useRpcMutation("account.signIn");
  const [email, setEmail] = useState(status.codeSentTo ?? "");
  const [code, setCode] = useState("");
  const [changing, setChanging] = useState(false);
  const sentTo = changing ? null : status.codeSentTo;
  const submit = () => {
    if (sentTo) signIn.mutate({ email: sentTo, code: code.trim() }, { onSettled: () => setCode("") });
    else send.mutate({ email: email.trim() }, { onSuccess: () => setChanging(false) });
  };
  const error = sentTo ? signIn.error : send.error;
  const onEnter = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !send.isPending && !signIn.isPending) submit();
  };
  return (
    <Section
      title="Sign in"
      description={status.ended ? "Your session ended. Sign in again." : undefined}
      actions={
        sentTo ? (
          <TextButton tone="muted" disabled={signIn.isPending} onClick={() => setChanging(true)}>
            Use another address
          </TextButton>
        ) : null
      }
    >
      {sentTo ? (
        <SettingRow label="Code" hint={`Sent to ${sentTo}`}>
          <Input
            aria-label="Code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            value={code}
            disabled={signIn.isPending}
            onKeyDown={onEnter}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
          <Button variant="primary" disabled={signIn.isPending || code.length !== 6} onClick={submit}>
            {signIn.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </SettingRow>
      ) : (
        <SettingRow label="Email">
          <Input aria-label="Email" type="email" autoComplete="email" value={email} disabled={send.isPending} onKeyDown={onEnter} onChange={(e) => setEmail(e.target.value)} />
          <Button variant="primary" disabled={send.isPending || !email.trim()} onClick={submit}>
            {send.isPending ? "Sending…" : "Send code"}
          </Button>
        </SettingRow>
      )}
      <Failure error={error ?? (status.error ? new Error(status.error) : null)} />
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
      <SettingRow label="Plan" hint={waiting("pro") ?? planHint(account)}>
        <Status ok={account.plan.pro && account.plan.standing !== "grace"}>{account.plan.pro ? "Pro" : "Free"}</Status>
        {moves.plan.page === "pro" ? <Segmented size="sm" label="Pay" value={period} options={periods} onChange={setPeriod} /> : null}
        {move(moves.plan, moves.plan.page === "pro" ? { page: "pro", period } : { page: "billing" })}
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

/** When Pro renews or ends, or, for a month not paid for, that the payment has not gone through. */
function planHint(account: SignedIn): string | undefined {
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
