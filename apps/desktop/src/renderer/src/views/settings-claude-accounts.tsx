import { Menu } from "@base-ui/react/menu";
import { useState } from "react";
import type { ClaudeAccountConnection } from "@openorc/protocol";
import { ChevronDown, MoreHorizontal, Plus } from "../components/icons";
import { menuItem, menuPopup, menuSeparator } from "../components/menu";
import { Button, IconButton, Input } from "../components/ui";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc, useRpcMutation } from "../lib/client";
import { floatingGround } from "../lib/use-anchor-ground";
import { Section, Status, Toggle, usePreference } from "./settings-shared";
import "./settings-claude-accounts.css";

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
    <Section title="Claude accounts" flush>
      <div className="settings-toolbar">
        <p>The default applies to new threads.</p>
        <Button size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate({ refresh: true })}>
          Refresh accounts
        </Button>
      </div>
      <div className="settings-account-list" data-plane aria-description="Each account keeps its own Claude login, settings, plugins, and usage. Existing threads keep their account.">
        {accounts.data?.accounts.map((account) => (
          <AccountRow key={account.id} account={account} isDefault={accounts.data.defaultId === account.id} />
        ))}
        <details className="settings-account-add">
          <summary aria-label="Add account">
            <Plus size={16} />
            <span>Add account</span>
            <ChevronDown size={14} className="settings-agent-chevron" />
          </summary>
          <form
            className="settings-account-form"
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
            <label className="settings-account-label">
              Account name
              <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Work, Personal, Client…" required />
            </label>
            <Button size="sm" type="submit" disabled={!name.trim() || add.isPending || login.isPending}>
              Add account and sign in
            </Button>
          </form>
        </details>
      </div>
      {(accounts.data?.accounts.filter((account) => account.enabled).length ?? 0) > 1 ? <AutoSwitch /> : null}
      {accounts.isPending ? <p className="settings-note">Checking accounts…</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-bad mt-2">
          {error.message}
        </p>
      ) : null}
    </Section>
  );
}

function AutoSwitch() {
  const preference = usePreference("app.settings.set");
  return (
    <div className="settings-group settings-account-preferences">
      <Toggle
        label="Switch accounts at usage limits"
        hint="Continue with the account that has the most 5-hour usage left. Projects with their own accounts use their own setting."
        checked={preference.value.claudeAccountAutoSwitch ?? false}
        disabled={preference.disabled}
        onChange={(claudeAccountAutoSwitch) => void preference.commit({ claudeAccountAutoSwitch })}
      />
    </div>
  );
}

function AccountRow({ account, isDefault }: { account: ClaudeAccountConnection; isDefault: boolean }) {
  const update = useRpcMutation("claude.accounts.update");
  const [name, setName] = useState(account.name);
  const [editing, setEditing] = useState(false);
  return (
    <div className="settings-account-row" role="group" aria-label={account.name}>
      <div className="min-w-0">
        <div className="settings-account-title">
          <h3>{account.name}</h3>
          {isDefault ? <span className="settings-account-default">Default</span> : null}
        </div>
        <p className="settings-account-meta">{accountMeta(account)}</p>
      </div>
      <AccountActions
        account={account}
        isDefault={isDefault}
        onRename={() => {
          setName(account.name);
          setEditing(true);
        }}
      />
      {account.message ? (
        <p className="settings-account-feedback" role="status">
          {account.message}
        </p>
      ) : null}
      {update.error ? (
        <p className="settings-account-feedback text-bad" role="alert">
          {update.error.message}
        </p>
      ) : null}
      {editing ? (
        <form
          className="settings-account-form settings-account-rename"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || update.isPending) return;
            update.mutate({ id: account.id, name: name.trim() }, { onSuccess: () => setEditing(false) });
          }}
        >
          <label className="settings-account-label">
            Account name
            <Input aria-label={`Name for ${account.name}`} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus required />
          </label>
          <Button size="sm" type="submit" disabled={!name.trim() || update.isPending}>
            Save name
          </Button>
          <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : null}
    </div>
  );
}

/** Who an account signs in as, or what kind of login it is before it has signed in. */
export function accountMeta(account: ClaudeAccountConnection): string {
  return (
    [account.email, account.organization].filter(Boolean).join(" · ") ||
    (account.kind === "cli" ? "Uses your existing Claude Code login and configuration." : "Separate Claude Code login and configuration.")
  );
}

export const connectionLabels: Record<ClaudeAccountConnection["status"], string> = {
  ready: "Connected",
  signing_in: "Signing in…",
  disabled: "Disabled",
  signed_out: "Sign in needed",
  unavailable: "CLI unavailable",
};

function AccountActions({ account, isDefault, onRename }: { account: ClaudeAccountConnection; isDefault: boolean; onRename: () => void }) {
  const update = useRpcMutation("claude.accounts.update");
  const login = useRpcMutation("claude.accounts.login");
  const cancel = useRpcMutation("claude.accounts.cancelLogin");
  const error = update.error ?? login.error ?? cancel.error;
  const signingIn = account.status === "signing_in";
  const needsSignIn = account.enabled && !signingIn && account.status !== "ready";
  return (
    <>
      <div className="settings-account-actions">
        <Status ok={account.status === "ready"}>{connectionLabels[account.status]}</Status>
        {signingIn ? (
          <Button size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate({ id: account.id })}>
            Cancel sign-in
          </Button>
        ) : null}
        {needsSignIn ? (
          <Button size="sm" disabled={login.isPending} onClick={() => login.mutate({ id: account.id })}>
            Sign in
          </Button>
        ) : null}
        <Menu.Root>
          <Menu.Trigger render={<IconButton aria-label={`More for ${account.name}`} size="sm" />}>
            <MoreHorizontal size={16} />
          </Menu.Trigger>
          <Menu.Portal>
            <CoversPreview />
            <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
              <Menu.Popup ref={floatingGround} className={menuPopup}>
                {!isDefault && account.enabled ? (
                  <Menu.Item className={menuItem} disabled={update.isPending} onClick={() => update.mutate({ id: account.id, makeDefault: true })}>
                    Make default
                  </Menu.Item>
                ) : null}
                <Menu.Item className={menuItem} disabled={update.isPending} onClick={onRename}>
                  Rename
                </Menu.Item>
                {account.enabled && account.status === "ready" ? (
                  <Menu.Item className={menuItem} disabled={login.isPending} onClick={() => login.mutate({ id: account.id })}>
                    Sign in again
                  </Menu.Item>
                ) : null}
                {!isDefault ? (
                  <>
                    <Menu.Separator className={menuSeparator} />
                    <Menu.Item className={menuItem} disabled={update.isPending || signingIn} onClick={() => update.mutate({ id: account.id, enabled: !account.enabled })}>
                      {account.enabled ? "Disable" : "Enable"}
                    </Menu.Item>
                  </>
                ) : null}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
      {error ? (
        <p className="settings-account-feedback text-bad" role="alert">
          {error.message}
        </p>
      ) : null}
    </>
  );
}
