import { useState } from "react";
import type { ClaudeAccountConnection } from "@openorc/protocol";
import { Badge, Button, Input, TextButton } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/query";
import { Section } from "./settings-shared";

export function ClaudeAccountSettings({ active }: { active: boolean }) {
  const accounts = useRpc(
    "claude.accounts.list",
    {},
    { enabled: active, refetchInterval: (query) => (active && query.state.data?.accounts.some((account) => account.status === "signing_in") ? 1500 : false) },
  );
  const refresh = useRpcMutation("claude.accounts.list");
  const add = useRpcMutation("claude.accounts.add");
  const login = useRpcMutation("claude.accounts.login");
  const [name, setName] = useState("");
  const error = accounts.error ?? refresh.error ?? add.error ?? login.error;
  return (
    <Section title="Claude accounts" description="Add as many accounts as you need. Each account keeps its own Claude login, settings, plugins, and usage. Choose an account when starting a thread.">
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-sm text-ink-2">Changing the default affects new threads. Existing threads keep their account.</p>
        <Button size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate({ refresh: true })}>
          Refresh accounts
        </Button>
      </div>
      {accounts.data?.accounts.map((account) => (
        <AccountRow key={account.id} account={account} isDefault={accounts.data.defaultId === account.id} />
      ))}
      <form
        className="flex flex-wrap items-end gap-2 mt-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || add.isPending) return;
          add.mutate(
            { name: name.trim() },
            {
              onSuccess: (account) => {
                setName("");
                login.mutate({ id: account.id });
              },
            },
          );
        }}
      >
        <label className="text-sm flex flex-col gap-1 flex-1 min-w-40">
          Account name
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Work, Personal, Client…" required />
        </label>
        <Button type="submit" disabled={!name.trim() || add.isPending || login.isPending}>
          Add account and sign in
        </Button>
      </form>
      {accounts.isPending ? <p className="text-sm text-ink-2 mt-2">Checking accounts…</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-bad mt-2">
          {error.message}
        </p>
      ) : null}
    </Section>
  );
}

function AccountRow({ account, isDefault }: { account: ClaudeAccountConnection; isDefault: boolean }) {
  const update = useRpcMutation("claude.accounts.update");
  const [name, setName] = useState(account.name);
  return (
    <div className="py-3 border-b border-line">
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label={`Name for ${account.name}`} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} className="max-w-56" />
        {name.trim() !== account.name ? (
          <Button size="sm" disabled={!name.trim() || update.isPending} onClick={() => update.mutate({ id: account.id, name: name.trim() })}>
            Save name
          </Button>
        ) : null}
        <Badge tone={account.status === "ready" ? "ok" : "muted"}>{connectionLabels[account.status]}</Badge>
        <AccountActions account={account} isDefault={isDefault} />
      </div>
      <p className="text-sm text-ink-2 mt-1">
        {[account.email, account.organization].filter(Boolean).join(" · ") ||
          (account.kind === "cli" ? "Uses your existing Claude Code login and configuration." : "Separate Claude Code login and configuration.")}
      </p>
      {account.message ? (
        <p className="text-sm text-ink-2 mt-1" role="status">
          {account.message}
        </p>
      ) : null}
      {update.error ? (
        <p className="text-sm text-bad mt-1" role="alert">
          {update.error.message}
        </p>
      ) : null}
    </div>
  );
}

const connectionLabels: Record<ClaudeAccountConnection["status"], string> = {
  ready: "Connected",
  signing_in: "Signing in…",
  disabled: "Disabled",
  signed_out: "Sign in needed",
  unavailable: "CLI unavailable",
};

function AccountActions({ account, isDefault }: { account: ClaudeAccountConnection; isDefault: boolean }) {
  const update = useRpcMutation("claude.accounts.update");
  return (
    <>
      {isDefault ? <Badge>Default</Badge> : null}
      {!isDefault && account.enabled ? (
        <Button size="sm" disabled={update.isPending} onClick={() => update.mutate({ id: account.id, makeDefault: true })}>
          Make default
        </Button>
      ) : null}
      <AccountLogin account={account} />
      {!isDefault ? (
        <TextButton disabled={update.isPending || account.status === "signing_in"} onClick={() => update.mutate({ id: account.id, enabled: !account.enabled })}>
          {account.enabled ? "Disable" : "Enable"}
        </TextButton>
      ) : null}
      {update.error ? (
        <p className="text-sm text-bad w-full" role="alert">
          {update.error.message}
        </p>
      ) : null}
    </>
  );
}

function AccountLogin({ account }: { account: ClaudeAccountConnection }) {
  const login = useRpcMutation("claude.accounts.login");
  const cancel = useRpcMutation("claude.accounts.cancelLogin");
  const error = login.error ?? cancel.error;
  if (!account.enabled) return null;
  return (
    <>
      {account.status === "signing_in" ? (
        <Button size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate({ id: account.id })}>
          Cancel sign-in
        </Button>
      ) : (
        <Button size="sm" disabled={login.isPending} onClick={() => login.mutate({ id: account.id })}>
          {account.status === "ready" ? "Sign in again" : "Sign in"}
        </Button>
      )}
      {error ? (
        <p className="text-sm text-bad w-full" role="alert">
          {error.message}
        </p>
      ) : null}
    </>
  );
}
