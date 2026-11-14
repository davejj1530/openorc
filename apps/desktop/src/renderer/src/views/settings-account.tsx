import { billingMoves, cloudTime, hoursDetail } from "@openorc/client";
import { type AccountStatus } from "@openorc/protocol";
import { useEffect, useState } from "react";
import { Button, TextButton } from "../components/ui";
import { AccountFace } from "../components/AccountFace";
import { ProfileDialog } from "../dialogs/ProfileDialog";
import { useRpc, useRpcMutation } from "../lib/client";
import { Failure } from "./settings-secret-field";
import { LoadError, Section, SettingRow, Status } from "./settings-shared";

import { AccountSeatPlan, PaymentAction, type PaymentControls } from "./AccountSeatPlan";
import { useAccountSeatState } from "../lib/account-seat-state";

type SignedOut = Extract<AccountStatus, { state: "signed-out" }>;
type SignedIn = Extract<AccountStatus, { state: "signed-in" }>;

/** Settings > Account. Everything shown is `account.status`, which the core keeps and announces, so every window agrees. */
export function AccountSettings({ active }: { active: boolean }) {
  const status = useRpc("account.status", {}, { enabled: active });
  const { account } = useAccountSeatState(status.data);
  if (status.isError) return <LoadError retry={() => void status.refetch()} />;
  if (!account || account.state === "unavailable") return null;
  return account.state === "signed-in" ? <SignedInAccount key={account.email} account={account} active={active} /> : <SignIn status={account} />;
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
  const [editing, setEditing] = useState(false);
  const signOut = useRpcMutation("account.signOut");
  const open = useRpcMutation("account.billing.open");
  const live = account.reach === "live";
  return (
    <>
      <Section
        title={account.name ?? account.email}
        intro={
          <header className="settings-profile-heading">
            <AccountFace name={account.name ?? account.email} image={account.image} className="settings-profile-face" />
            <div className="settings-profile-identity">
              <h2>{account.name ?? account.email}</h2>
              {account.name ? <p>{account.email}</p> : null}
            </div>
            <div className="settings-section-actions">
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button size="sm" disabled={signOut.isPending} onClick={() => signOut.mutate({})}>
                Sign out
              </Button>
            </div>
          </header>
        }
      >
        <PlanRows account={account} active={active} opening={open.isPending} onOpen={(page) => open.mutate(page)} />
        <SettingRow label="OpenOrc Cloud">
          <Status ok={live}>{live ? "Connected" : "Can't be reached"}</Status>
        </SettingRow>
        <Failure error={open.error ?? signOut.error ?? (account.error ? new Error(account.error) : null)} />
      </Section>
      {editing ? <ProfileDialog key={account.email} account={account} close={() => setEditing(false)} /> : null}
    </>
  );
}

/**
 * The plan and the hours, each row ending in its way to pay. The one that fixes what the account lacks is the column's
 * ink pill, so a person sent here to upgrade, buy hours or fix a payment lands on that move. A page opened to pay is
 * watched by the core until its purchase lands or the person leaves this screen.
 */
function PlanRows({ account, active, ...controls }: { account: SignedIn; active: boolean } & PaymentControls) {
  useLeaveBilling(active && account.paying !== null);
  // Asked again on each visit to this screen; a price missing or not read shows none and blocks nothing.
  const offers = useRpc("account.offers", {}, { enabled: active, staleTime: 0 }).data ?? null;
  const moves = billingMoves(account, offers);
  const waitingForHours = account.paying?.page === "hours";
  return (
    <>
      <AccountSeatPlan account={account} offers={offers} move={moves.plan} {...controls} />
      <AccountHours account={account} moves={moves} waiting={waitingForHours} {...controls} />
    </>
  );
}

function AccountHours({ account, moves, waiting, ...controls }: { account: SignedIn; moves: ReturnType<typeof billingMoves>; waiting: boolean } & PaymentControls) {
  const frozen = account.organizationAccess?.state === "frozen";
  if (!account.hours) return frozen && account.organizationAccess?.reason !== "no_pro" ? <SettingRow label="Cloud hours" hint="Not available" children={null} /> : null;
  const hint = hoursDetail(account.hours) || (frozen && account.hours.leftSeconds === 0 ? "No hours available" : undefined);
  return (
    <SettingRow label="Cloud hours" hint={waiting ? "Waiting for your payment" : hint}>
      <span className="tabular">{cloudTime(account.hours.leftSeconds)} left</span>
      {moves.hours && !frozen ? <PaymentAction move={moves.hours} page={{ page: "hours" }} waiting={waiting} {...controls} /> : null}
    </SettingRow>
  );
}

/** While a page opened to pay is watched, leaving this screen (another section, or out of Settings) stops the watch. */
function useLeaveBilling(watching: boolean) {
  const { mutate } = useRpcMutation("account.billing.leave");
  useEffect(() => {
    if (!watching) return;
    return () => mutate({});
  }, [watching, mutate]);
}
