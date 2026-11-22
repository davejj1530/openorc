import { useEffect, useRef, type KeyboardEvent } from "react";
import { percentLeft, sessionWindow, weeklyWindow, type ClaudeAccountConnection, type ProviderUsage, type RpcParams } from "@openorc/protocol";
import { ensureRpc, useRpcs } from "../lib/client";
import { openProject, useRouter, type SettingsSection } from "../lib/router";
import { Check } from "./icons";
import { useHostedControlReason } from "./HostedConversationBoundary";
import { HostedControlReason } from "./HostedControlReason";

/**
 * The accounts a picker offers: its choices, the one in use, and how a choice is made. This Mac's Claude accounts, or
 * on OpenOrc Cloud the person's accounts for the thread's agent, in that agent's section.
 */
export interface PickerAccounts {
  accounts: readonly Pick<ClaudeAccountConnection, "id" | "name" | "status">[];
  current: string;
  choose: (id: string) => void;
  /** Why choosing is off for now, as while a turn runs. */
  blocked?: string | undefined;
  /** A switch that failed, in its own words. */
  error?: string | undefined;
  /** Forgets a failed switch once the picker closes. */
  clearError?: (() => void) | undefined;
  /** The account the conversation runs on that its project no longer uses, listed until the conversation moves. */
  outside?: string | undefined;
  /** The project, when it uses only some accounts, so its accounts are a click away. */
  project?: { id: string; name: string } | undefined;
  /** The person's accounts on OpenOrc Cloud, the only ones a cloud conversation offers; this Mac's when absent. */
  cloud?: true | undefined;
  /**
   * The picker section the accounts head; Claude's when none. A cloud thread's accounts are its agent's own. This Mac's
   * are Claude's in any section, headed "Claude account" in another agent's, whose thread belongs to one of them.
   */
  section?: string | undefined;
  /** How an account's usage is read; this Mac's Claude account's when none. */
  usage?: ((id: string) => RpcParams<"providers.usage">) | undefined;
  /** Where Manage accounts goes; Settings > Connections when none. */
  manage?: SettingsSection | undefined;
}

/** A report this young answers at once from what any reader last fetched; only older ones ask the CLI again. */
const USAGE_AGE_MS = 5 * 60_000;
const usageParams = (claudeAccountId: string): RpcParams<"providers.usage"> => ({ provider: "claude", claudeAccountId, maxAgeMs: USAGE_AGE_MS });

const unavailable: Record<ClaudeAccountConnection["status"], string | null> = {
  ready: null,
  signing_in: "Signing in",
  signed_out: "Signed out",
  disabled: "Disabled",
  unavailable: "Unavailable",
};

/** Only a signed-in account has usage to read. */
const readable = (accounts: PickerAccounts["accounts"]) => accounts.filter((account) => account.status === "ready");

/** Starts each account's usage read as the pointer or focus reaches the picker's trigger, so its rows fill as they show. */
export function warmAccountUsage(accounts: PickerAccounts | undefined) {
  const warm = () => {
    const usage = accounts?.usage ?? usageParams;
    for (const account of readable(accounts?.accounts ?? [])) void ensureRpc("providers.usage", usage(account.id)).catch(() => undefined);
  };
  return { onPointerEnter: warm, onFocus: warm };
}

/** What an account has left, the 5-hour window then the week's, or why it says nothing. */
function usageWords(usage: ProviderUsage | undefined, loading: boolean): { text: string; title: string } | null {
  if (!usage) return loading ? { text: "…", title: "Checking usage" } : null;
  if (usage.status === "disconnected") return { text: "Not signed in", title: "Not signed in" };
  const left = (window: ReturnType<typeof weeklyWindow>) => (window ? percentLeft(window) : null);
  const session = left(sessionWindow(usage.windows));
  const week = left(weeklyWindow(usage.windows));
  const parts = [session === null ? null : `${Math.round(session)}% 5h`, week === null ? null : `${Math.round(week)}% wk`].filter(Boolean);
  if (!parts.length) return null;
  const title = [session === null ? null : `${Math.round(session)}% left in 5 hours`, week === null ? null : `${Math.round(week)}% left this week`].filter(Boolean).join(" · ");
  return { text: parts.join(" · "), title };
}

/**
 * The accounts at the top of their agent's section of the picker, this Mac's Claude accounts or a cloud thread's: each
 * with what it has left, read for every account at once and filled in as each answers, the one in use checked.
 * Choosing one moves the conversation or the new thread to it. A cloud thread on a server that keeps one sign-in per
 * agent holds the row with its reason.
 */
export function PickerAccountRows({
  section,
  searching,
  accounts,
  disabled,
  moveRowFocus,
}: {
  /** The picker's section: the accounts show in their agent's, above its models, while no search is narrowing them. */
  section: string | null;
  searching: boolean;
  accounts: PickerAccounts | undefined;
  disabled?: boolean | undefined;
  moveRowFocus: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const cloudReason = useHostedControlReason("claudeAccount");
  if (searching) return null;
  const offered = cloudReason && !accounts?.cloud ? undefined : accounts;
  if (offered && section === (offered.section ?? "claude")) return <AccountRows accounts={offered} disabled={disabled} moveRowFocus={moveRowFocus} />;
  if (cloudReason && !offered && section === "claude")
    return (
      <HostedControlReason label="Claude account" reason={cloudReason}>
        <button type="button" aria-label="Claude account" className="model-picker-row" disabled>
          Account
        </button>
      </HostedControlReason>
    );
  return null;
}

function AccountRows({ accounts, disabled, moveRowFocus }: { accounts: PickerAccounts; disabled?: boolean | undefined; moveRowFocus: (event: KeyboardEvent<HTMLButtonElement>) => void }) {
  const ready = readable(accounts.accounts);
  const reads = useRpcs(
    "providers.usage",
    ready.map((account) => (accounts.usage ?? usageParams)(account.id)),
    { staleTime: 60_000 },
  );
  const usageOf = (id: string) => reads[ready.findIndex((account) => account.id === id)];
  const clearError = useRef(accounts.clearError);
  clearError.current = accounts.clearError;
  useEffect(() => () => clearError.current?.(), []);
  const inClaude = (accounts.section ?? "claude") === "claude";
  const name = inClaude || !accounts.cloud ? "Claude account" : "Account";
  return (
    <div className="model-picker-group" role="group" aria-label={name}>
      <div className="model-picker-group-label">{inClaude ? "Account" : name}</div>
      {accounts.blocked ? (
        <p role="status" className="model-picker-message">
          {accounts.blocked}
        </p>
      ) : null}
      {accounts.error ? (
        <p role="alert" className="model-picker-message text-bad">
          {accounts.error}
        </p>
      ) : null}
      {accounts.accounts.map((account) => {
        const current = account.id === accounts.current;
        const reason = current ? null : unavailable[account.status];
        const apart = account.id === accounts.outside ? "Not in this project" : null;
        const read = usageOf(account.id);
        const usage = usageWords(read?.data, Boolean(read?.isPending));
        return (
          <button
            key={account.id}
            type="button"
            data-picker-row
            className="model-picker-row model-picker-account"
            aria-pressed={current}
            data-tip={reason ?? usage?.title ?? account.name}
            disabled={disabled || Boolean(accounts.blocked) || Boolean(reason)}
            onClick={() => accounts.choose(account.id)}
            onKeyDown={moveRowFocus}
          >
            <span className="model-picker-row-name">{account.name}</span>
            {current ? <Check size={15} className="model-picker-check" aria-hidden="true" /> : null}
            {reason || apart || usage ? <span className="model-picker-row-meta tabular">{reason ?? apart ?? usage?.text}</span> : null}
          </button>
        );
      })}
      {accounts.project ? (
        <button type="button" className="model-picker-text-action" onClick={() => openProject(accounts.project!.id)}>
          {accounts.project.name}’s accounts
        </button>
      ) : null}
      <button type="button" className="model-picker-text-action" onClick={() => useRouter.getState().navigate({ view: "settings", section: accounts.manage ?? "connections" })}>
        Manage accounts
      </button>
    </div>
  );
}
