import { DEFAULT_CLAUDE_ACCOUNT, type ClaudeAccountConnection, type ThreadSummary } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../client";
import type { ComposerSettings } from "./settings-bridge";

/**
 * A composer's Claude account choice: the Mac's accounts, and the one its thread runs on, or a new thread would (the
 * chosen one, else the Mac's default). Null with a single account, until the Mac lists them, and where the account
 * cannot change.
 */
export function useClaudeAccountChoice(settings: ComposerSettings | undefined) {
  const list = useRpc("claude.accounts.list", {}, { enabled: Boolean(settings?.claudeAccount) });
  if (!settings?.claudeAccount || !list.data || list.data.accounts.length < 2) return null;
  const { chosen, select, held = null, failed = null } = settings.claudeAccount;
  const id = chosen ?? list.data.defaultId;
  return { accounts: list.data.accounts, id, current: list.data.accounts.find((account) => account.id === id), select, held, failed };
}

/**
 * An open Claude thread's account, which it leaves for another between turns: its next message resumes the
 * conversation there. An Orcling's conversation keeps its own, as on the Mac.
 */
export function useThreadClaudeAccount(thread: ThreadSummary | null): ComposerSettings["claudeAccount"] {
  const switching = useRpcMutation("threads.switchClaudeAccount");
  if (!thread || thread.agent !== "claude" || thread.orclingId || thread.teamInstanceId) return undefined;
  return {
    chosen: thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT,
    select: (claudeAccountId) => switching.mutate({ id: thread.id, claudeAccountId }),
    held: thread.activity === "idle" ? null : "Switch accounts when this turn ends.",
    failed: switching.error ? `Couldn’t switch accounts. ${switching.error.message}` : null,
  };
}

/** Why a thread cannot start on this account, or null: both are put right on the Mac. */
export function claudeAccountUnavailable(account: ClaudeAccountConnection): string | null {
  if (!account.enabled) return "Turned off";
  if (account.status === "signed_out") return "Signed out";
  return null;
}

/** The models a composer offers: its thread's or draft's Claude account, else the Mac's default account. */
export function useComposerModels(settings: ComposerSettings | undefined) {
  const claudeAccountId = settings?.claudeAccount?.chosen ?? settings?.claudeAccountId;
  // The last account's list holds while the next one's loads, so the chip keeps its name.
  return useRpc("agents.models", claudeAccountId ? { claudeAccountId } : {}, { staleTime: 5 * 60_000, placeholderData: (previous) => previous });
}
