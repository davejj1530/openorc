import { useState, type ReactNode } from "react";
import type { ClaudeAccountConnection, ClaudeCloudAccess, CloudStatus } from "@openorc/protocol";
import { Button, Input, Select, TextButton } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { Field, LoadError, Section, SettingRow, Status } from "./settings-shared";

const TOKENS_URL = "https://vercel.com/account/settings/tokens";

function Failure({ error }: { error: Error | null | undefined }) {
  return error ? (
    <p role="alert" className="text-bad mt-2">
      {error.message}
    </p>
  ) : null;
}

/** A secret typed once: it goes to the core and the field empties. */
function TokenField({ label, hint, action, busy, onSave }: { label: string; hint: ReactNode; action: string; busy: boolean; onSave: (token: string) => void }) {
  const [token, setToken] = useState("");
  return (
    <SettingRow label={label} hint={hint}>
      <Input type="password" autoComplete="off" spellCheck={false} value={token} disabled={busy} placeholder="Paste token" onChange={(e) => setToken(e.target.value)} />
      <Button
        disabled={busy || !token.trim()}
        onClick={() => {
          onSave(token.trim());
          setToken("");
        }}
      >
        {action}
      </Button>
    </SettingRow>
  );
}

function VercelTeam({ vercel }: { vercel: NonNullable<CloudStatus["vercel"]> }) {
  const teams = useRpc("cloud.vercel.teams", {});
  const choose = useRpcMutation("cloud.vercel.team");
  const disconnect = useRpcMutation("cloud.vercel.disconnect");
  const busy = choose.isPending || disconnect.isPending;
  return (
    <>
      <Field label="Team" hint={vercel.project ? `Sandboxes belong to its ${vercel.project} project.` : "Choose where sandboxes run."}>
        <Select value={vercel.team?.id ?? ""} disabled={busy || !teams.data} onChange={(e) => e.target.value && choose.mutate({ teamId: e.target.value })}>
          {vercel.team ? null : <option value="">Choose a team</option>}
          {(teams.data ?? (vercel.team ? [vercel.team] : [])).map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </Select>
      </Field>
      <SettingRow label="Account">
        <Status ok={Boolean(vercel.team)}>{vercel.team ? "Connected" : "Choose a team"}</Status>
        <Button variant="ghost" disabled={busy} onClick={() => disconnect.mutate({})}>
          Disconnect
        </Button>
      </SettingRow>
      <Failure error={teams.error ?? choose.error ?? disconnect.error} />
    </>
  );
}

function VercelSettings({ status }: { status: CloudStatus }) {
  const connect = useRpcMutation("cloud.vercel.connect");
  return (
    <Section title="Vercel" description="Cloud threads run in Vercel Sandbox, on your account.">
      {status.vercel ? (
        <VercelTeam vercel={status.vercel} />
      ) : (
        <>
          <TokenField
            label="Access token"
            hint={
              <>
                Create one in{" "}
                <TextButton underline onClick={() => window.openorc.openExternal(TOKENS_URL)}>
                  your Vercel account
                </TextButton>
                .
              </>
            }
            action="Connect"
            busy={connect.isPending}
            onSave={(token) => connect.mutate({ token })}
          />
          <Failure error={connect.error} />
        </>
      )}
    </Section>
  );
}

function accountDetail(account: ClaudeAccountConnection): string {
  return [account.email, account.organization].filter(Boolean).join(" · ") || (account.kind === "cli" ? "Your Claude Code login" : "Added account");
}

/** Where the browser sign-in opens, and which login to use there, since a token cannot say whose it is. */
function signInHint(account: ClaudeAccountConnection): string {
  const who = account.email ? `as ${account.email}` : "with this account";
  return account.kind === "managed" ? `Sign in ${who} in the private window that opened.` : `Sign in ${who} in your browser.`;
}

function ClaudeCloudAccount({ account, access }: { account: ClaudeAccountConnection; access: ClaudeCloudAccess | undefined }) {
  const create = useRpcMutation("cloud.claude.create");
  const cancel = useRpcMutation("cloud.claude.cancel");
  const save = useRpcMutation("cloud.claude.save");
  const remove = useRpcMutation("cloud.claude.remove");
  const [pasting, setPasting] = useState(false);
  const busy = create.isPending || cancel.isPending || save.isPending || remove.isPending;
  const accountId = account.id;
  const ready = access?.createdAt != null;
  const make = () => create.mutate({ accountId });
  let controls: ReactNode;
  if (access?.creating)
    controls = (
      <>
        <Status>Waiting for sign-in</Status>
        <Button variant="ghost" disabled={busy} onClick={() => cancel.mutate({ accountId })}>
          Cancel
        </Button>
      </>
    );
  else if (ready)
    controls = (
      <>
        <Status ok>Ready</Status>
        <TextButton tone="muted" disabled={busy} onClick={make}>
          Replace
        </TextButton>
        <TextButton tone="muted" disabled={busy} onClick={() => remove.mutate({ accountId })}>
          Remove
        </TextButton>
      </>
    );
  else
    controls = (
      <>
        <Button disabled={busy} onClick={make}>
          Create token
        </Button>
        <TextButton tone="muted" disabled={busy} onClick={() => setPasting(!pasting)}>
          Paste token
        </TextButton>
      </>
    );
  return (
    <>
      <SettingRow label={account.name} hint={access?.creating ? signInHint(account) : accountDetail(account)}>
        {controls}
      </SettingRow>
      {pasting && !ready && !access?.creating ? (
        <TokenField
          label="Token"
          hint={
            <>
              From <code>claude setup-token</code>, signed in as this account.
            </>
          }
          action="Save"
          busy={busy}
          onSave={(token) => save.mutate({ accountId, token }, { onSuccess: () => setPasting(false) })}
        />
      ) : null}
      <Failure error={create.error ?? cancel.error ?? save.error ?? remove.error ?? (access?.error ? new Error(access.error) : null)} />
    </>
  );
}

/** One row per enabled Claude account: each signs in to sandboxes with its own token, on its own subscription. */
function ClaudeCloudAccounts({ status, active }: { status: CloudStatus; active: boolean }) {
  const accounts = useRpc("claude.accounts.list", {}, { enabled: active });
  return (
    <Section title="Claude accounts" description="Each account signs in to sandboxes with a token from its own subscription.">
      {accounts.data?.accounts
        .filter((account) => account.enabled)
        .map((account) => (
          <ClaudeCloudAccount key={account.id} account={account} access={status.claude[account.id]} />
        ))}
      <Failure error={accounts.error} />
    </Section>
  );
}

/** Where cloud threads run and how their agents sign in. Tokens go to the core and stay in protected storage. */
export function CloudSettings({ active }: { active: boolean }) {
  const status = useRpc("cloud.status", {}, { enabled: active });
  if (status.isError) return <LoadError retry={() => void status.refetch()} />;
  if (!status.data) return null;
  return (
    <>
      {status.data.error ? (
        <p role="alert" className="text-bad my-3">
          {status.data.error}
        </p>
      ) : null}
      <VercelSettings status={status.data} />
      <ClaudeCloudAccounts status={status.data} active={active} />
    </>
  );
}
