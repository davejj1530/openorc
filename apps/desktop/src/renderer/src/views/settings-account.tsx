import { cloudTime, hoursDetail, planDate } from "@openorc/client";
import type { AccountStatus } from "@openorc/protocol";
import { useState, type KeyboardEvent } from "react";
import { Button, Input, TextButton } from "../components/ui";
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
  return status.data.state === "signed-in" ? <SignedInAccount account={status.data} /> : <SignIn status={status.data} />;
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

/** Who is signed in, their plan, their cloud hours, and whether OpenOrc Cloud answers now, with Sign out beside the name. */
function SignedInAccount({ account }: { account: SignedIn }) {
  const signOut = useRpcMutation("account.signOut");
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
      <SettingRow label="Plan" hint={planDate(account.plan) ?? undefined}>
        <Status ok={account.plan.pro}>{account.plan.pro ? "Pro" : "Free"}</Status>
      </SettingRow>
      {account.hours ? (
        <SettingRow label="Cloud hours" hint={hoursDetail(account.hours) || undefined}>
          <span className="tabular">{cloudTime(account.hours.leftSeconds)} left</span>
        </SettingRow>
      ) : null}
      <SettingRow label="OpenOrc Cloud">
        <Status ok={live}>{live ? "Connected" : "Can't be reached"}</Status>
      </SettingRow>
      <Failure error={signOut.error ?? (account.error ? new Error(account.error) : null)} />
    </Section>
  );
}
