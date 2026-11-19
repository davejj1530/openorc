import { cloudAccountChoices } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../client";
import { useOwnCloud } from "../cloud/use-own-cloud";
import type { AccountChoice, ComposerSettings, ModelSettings } from "./settings-bridge";

/**
 * A composer's OpenOrc Cloud account choice, as the desktop's picker offers it: the person's accounts for the turn's
 * agent from the phone's own session, the one its settings name checked when it is theirs, else their default. Null
 * where the server keeps one sign-in per agent or says an open thread's account cannot change, and while the phone
 * holds no session of its own.
 */
export function useCloudAccountChoice(settings: ModelSettings | undefined): AccountChoice | null {
  const own = useOwnCloud();
  const wanted = own && Boolean(settings?.cloudAccount);
  const threadId = settings?.cloudAccount?.threadId;
  const status = useRpc("account.status", {}, { enabled: wanted });
  const capabilities = useRpc("hosted.capabilities", { threadId: threadId ?? "" }, { enabled: wanted && Boolean(threadId), staleTime: 60_000 });
  const choice = settings?.choice;
  if (!wanted || !settings?.cloudAccount || !choice) return null;
  if (threadId && capabilities.data?.features.agentAccounts?.available !== true) return null;
  const { accountId, select, held = null, failed = null } = settings.cloudAccount;
  const choices = cloudAccountChoices(status.data, { agent: choice.agent, model: choice.model, accountId });
  if (!choices) return null;
  return {
    label: choice.agent === "claude" ? "Claude account" : "Account",
    section: choice.agent,
    accounts: choices.accounts.map((account) => ({ id: account.id, name: account.name, unavailable: account.status === "signed_out" ? "Signed out" : null })),
    id: choices.current,
    select: (id) => {
      if (id !== choices.current) select(id);
    },
    held,
    failed,
  };
}

/**
 * An open cloud thread's account, which its next turns run on, for everyone in it: a teammate's turns run on their own
 * default. It changes between turns.
 */
export function useThreadCloudAccount(thread: ThreadSummary | null): ComposerSettings["cloudAccount"] {
  const update = useRpcMutation("threads.update");
  if (!thread || thread.owner?.brain !== "hosted") return undefined;
  return {
    accountId: thread.cloudAccountId,
    select: (cloudAccountId) => update.mutate({ id: thread.id, patch: { cloudAccountId } }),
    held: thread.activity === "idle" ? null : "Switch accounts when this turn ends.",
    failed: update.error ? `Couldn’t switch accounts. ${update.error.message}` : null,
    threadId: thread.id,
  };
}
