import { useState } from "react";
import type { ClaudeAccountConnection } from "@openorc/protocol";
import { Button, Input, TextButton } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { Section, Status } from "./settings-shared";

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
    <Section
      title="Claude accounts"
      description="Add as many accounts as you need. Each account keeps its own Claude login, settings, plugins, and usage. Choose an account when starting a thread."
      flush
    >
      <div className="settings-toolbar">
        <p>Changing the default affects new threads. Existing threads keep their account.</p>
        <Button size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate({ refresh: true })}>
          Refresh accounts
        </Button>
      </div>
      <div className="settings-cards">
        {accounts.data?.accounts.map((account) => (
          <AccountCard key={account.id} account={account} isDefault={accounts.data.defaultId === account.id} />
        ))}
        <form
          className="settings-card"
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
          <label className="settings-card-label">
            Account name
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Work, Personal, Client…" required />
          </label>
          <div className="settings-card-actions">
            <Button size="sm" type="submit" disabled={!name.trim() || add.isPending || login.isPending}>
              Add account and sign in
            </Button>
          </div>
        </form>
      </div>
      {accounts.isPending ? <p className="settings-note">Checking accounts…</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-bad mt-2">
          {error.message}
        </p>
      ) : null}
    </Section>
  );
}

function AccountCard({ account, isDefault }: { account: ClaudeAccountConnection; isDefault: boolean }) {
  const update = useRpcMutation("claude.accounts.update");
  const [name, setName] = useState(account.name);
  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <Input aria-label={`Name for ${account.name}`} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} className="settings-label-input" />
        {isDefault ? <span className="settings-card-tag">Default</span> : null}
        <Status ok={account.status === "ready"}>{connectionLabels[account.status]}</Status>
      </div>
      <p className="settings-card-meta">
        {[account.email, account.organization].filter(Boolean).join(" · ") ||
          (account.kind === "cli" ? "Uses your existing Claude Code login and configuration." : "Separate Claude Code login and configuration.")}
      </p>
      {account.message ? (
        <p className="settings-card-meta" role="status">
          {account.message}
        </p>
      ) : null}
      {update.error ? (
        <p className="settings-card-meta text-bad" role="alert">
          {update.error.message}
        </p>
      ) : null}
      <div className="settings-card-actions">
        {name.trim() !== account.name ? (
          <Button size="sm" disabled={!name.trim() || update.isPending} onClick={() => update.mutate({ id: account.id, name: name.trim() })}>
            Save name
          </Button>
        ) : null}
        <AccountActions account={account} isDefault={isDefault} />
      </div>
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
      {!isDefault && account.enabled ? (
        <Button size="sm" disabled={update.isPending} onClick={() => update.mutate({ id: account.id, makeDefault: true })}>
          Make default
        </Button>
      ) : null}
      <AccountLogin account={account} />
      {!isDefault ? (
        <TextButton tone="muted" disabled={update.isPending || account.status === "signing_in"} onClick={() => update.mutate({ id: account.id, enabled: !account.enabled })}>
          {account.enabled ? "Disable" : "Enable"}
        </TextButton>
      ) : null}
      {update.error ? (
        <p className="settings-card-meta w-full text-bad" role="alert">
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
        <p className="settings-card-meta w-full text-bad" role="alert">
          {error.message}
        </p>
      ) : null}
    </>
  );
}
