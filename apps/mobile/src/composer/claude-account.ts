import { offeredAccount, projectAccountChoice } from "@openorc/client";
import { DEFAULT_CLAUDE_ACCOUNT, placeOf, type ClaudeAccountConnection, type ThreadSummary } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../client";
import type { AccountChoice, ComposerSettings, ModelSettings } from "./settings-bridge";

/**
 * A composer's Claude account choice: the Mac's accounts, or the ones its project uses when it uses only some (from
 * the cached project list; a Mac too old to say gives the app's), and the one its thread runs on, or a new thread would
 * (the chosen one, else the project's default). A thread already on an account its project stopped using keeps it
 * listed. Null with a single account, until the Mac lists them, and where the account cannot change.
 */
export function useClaudeAccountChoice(settings: ModelSettings | undefined): AccountChoice | null {
  const list = useRpc("claude.accounts.list", {}, { enabled: Boolean(settings?.claudeAccount) });
  const projects = useRpc("projects.list", {}, { enabled: Boolean(settings?.claudeAccount?.projectId) });
  if (!settings?.claudeAccount || !list.data || list.data.accounts.length < 2) return null;
  const { chosen, select, held = null, failed = null, projectId } = settings.claudeAccount;
  const choice = projectAccountChoice(
    projects.data?.find((project) => project.id === projectId),
    list.data,
  );
  const id = chosen ?? choice.defaultId;
  const current = list.data.accounts.find((account) => account.id === id);
  const accounts = current && !choice.accounts.includes(current) ? [...choice.accounts, current] : choice.accounts;
  return {
    label: "Claude account",
    section: "claude",
    accounts: accounts.map((account) => ({ id: account.id, name: account.name, unavailable: claudeAccountUnavailable(account) })),
    id,
    select,
    held,
    failed,
  };
}

/** A new thread's chosen account, unless its project uses only some accounts and not that one: then the Mac starts it on the project's default. */
export function useNewThreadClaudeAccount(projectId: string, chosen: string | undefined): string | undefined {
  const list = useRpc("claude.accounts.list", {}, { enabled: Boolean(chosen) });
  const projects = useRpc("projects.list", {}, { enabled: Boolean(chosen) });
  if (!chosen || !list.data) return chosen;
  return offeredAccount(
    projectAccountChoice(
      projects.data?.find((project) => project.id === projectId),
      list.data,
    ),
    chosen,
  );
}

/**
 * An open Claude thread's account, which it leaves for another between turns: its next message resumes the
 * conversation there. An Orcling's conversation keeps its own, as on the Mac, and an OpenOrc Cloud thread runs on the
 * person's sign-in there, not on an account of the Mac's.
 */
export function useThreadClaudeAccount(thread: ThreadSummary | null): ComposerSettings["claudeAccount"] {
  const switching = useRpcMutation("threads.switchClaudeAccount");
  if (!thread || thread.agent !== "claude" || thread.orclingId || thread.teamInstanceId || placeOf(thread).elsewhere) return undefined;
  return {
    chosen: thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT,
    select: (claudeAccountId) => switching.mutate({ id: thread.id, claudeAccountId }),
    held: thread.activity === "idle" ? null : "Switch accounts when this turn ends.",
    failed: switching.error ? `Couldn’t switch accounts. ${switching.error.message}` : null,
    projectId: thread.projectId,
  };
}

/** Why a thread cannot start on this account, or null: both are put right on the Mac. */
export function claudeAccountUnavailable(account: ClaudeAccountConnection): string | null {
  if (!account.enabled) return "Turned off";
  if (account.status === "signed_out") return "Signed out";
  return null;
}

/**
 * The models a composer offers: for a turn on OpenOrc Cloud the ones the cloud runs for the person, as its machines'
 * own agent CLIs list them; else, and where a server from before the cloud's catalog answers none, the Mac's for its
 * thread's or draft's Claude account, or the Mac's default account.
 */
export function useComposerModels(settings: ModelSettings | undefined) {
  const claudeAccountId = settings?.claudeAccount?.chosen ?? settings?.claudeAccountId;
  const cloud = useRpc("cloudModels.catalog", {}, { enabled: Boolean(settings?.cloud), staleTime: 5 * 60_000 });
  const served = Boolean(settings?.cloud) && Boolean(cloud.data);
  // A cloud turn reads the Mac's list only once its server says it keeps no catalog, or cannot be asked.
  const macWanted = !settings?.cloud || cloud.data === null || Boolean(cloud.error);
  // The last account's list holds while the next one's loads, so the chip keeps its name.
  const mac = useRpc("agents.models", claudeAccountId ? { claudeAccountId } : {}, { enabled: macWanted, staleTime: 5 * 60_000, placeholderData: (previous) => previous });
  return served ? { ...cloud, data: cloud.data!.models, isPlaceholderData: false } : mac;
}
