import type { ClaudeAccountConnection } from "@openorc/protocol";
import { useRpc } from "../client";
import type { ComposerSettings } from "./settings-bridge";

/**
 * A new thread's Claude account choice: the Mac's accounts, and the one the thread would run on (the chosen one, else
 * the Mac's default). Null on a thread, with a single account, and until the Mac lists them.
 */
export function useClaudeAccountChoice(settings: ComposerSettings | undefined) {
  const list = useRpc("claude.accounts.list", {}, { enabled: Boolean(settings?.claudeAccount) });
  if (!settings?.claudeAccount || !list.data || list.data.accounts.length < 2) return null;
  const id = settings.claudeAccount.chosen ?? list.data.defaultId;
  return { accounts: list.data.accounts, id, current: list.data.accounts.find((account) => account.id === id), select: settings.claudeAccount.select };
}

/** Why a thread cannot start on this account, or null: both are put right on the Mac. */
export function claudeAccountUnavailable(account: ClaudeAccountConnection): string | null {
  if (!account.enabled) return "Turned off";
  if (account.status === "signed_out") return "Signed out";
  return null;
}

/** The models a composer offers: the chosen Claude account's catalog, else the Mac's default account's. */
export function useComposerModels(settings: ComposerSettings | undefined) {
  const claudeAccountId = settings?.claudeAccount?.chosen;
  // The last account's list holds while the next one's loads, so the chip keeps its name.
  return useRpc("agents.models", claudeAccountId ? { claudeAccountId } : {}, { staleTime: 5 * 60_000, placeholderData: (previous) => previous });
}
