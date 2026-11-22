import { cloudAccountChoices, KEPT_SEPARATE, projectAccountChoice } from "@openorc/client";
import { isHarnessId, type AccountStatus, type Project, type ThreadSummary, type TurnAccountSettings } from "@openorc/protocol";
import type { PickerAccounts } from "../components/ModelPickerAccounts";
import { useAccountsSeparate } from "./accounts-separate";
import { useClaudeAccountId } from "./claude-account";
import { useRpc, useRpcMutation } from "./client";

/**
 * Which threads here show their Claude account: Claude's, and while accounts are kept separate any agent's, whose work
 * belongs to the account it started under, shown in that agent's section.
 */
function shownAccount(thread: ThreadSummary | null, separate: boolean): "claude" | "other" | null {
  if (!thread || thread.owner?.brain === "hosted") return null;
  if (thread.agent === "claude") return "claude";
  return separate ? "other" : null;
}

/**
 * A conversation's Claude accounts for its model picker: the project's choices, plus the thread's own when the project
 * stopped using it, so it stays listed until the thread moves. Choosing one moves the conversation between turns; the
 * next message resumes its session there. An Orcling keeps its own account.
 */
export function useThreadAccounts(thread: ThreadSummary | null, project: Pick<Project, "id" | "name" | "settings"> | null): PickerAccounts | undefined {
  const mac = useMacThreadAccounts(thread, project);
  const cloud = useCloudThreadAccounts(thread);
  return thread?.owner?.brain === "hosted" ? cloud : mac;
}

function useMacThreadAccounts(thread: ThreadSummary | null, project: Pick<Project, "id" | "name" | "settings"> | null): PickerAccounts | undefined {
  const scoped = useClaudeAccountId();
  const separate = useAccountsSeparate();
  const shown = shownAccount(thread, separate);
  const list = useRpc("claude.accounts.list", {}, { enabled: Boolean(shown) }).data;
  const switching = useRpcMutation("threads.switchClaudeAccount");
  if (!thread || !shown || !list || thread.teamInstanceId) return undefined;
  const current = scoped ?? thread.claudeAccountId ?? list.defaultId;
  const choice = projectAccountChoice(project, list);
  const outside = choice.restricted && !choice.accounts.some((account) => account.id === current) ? list.accounts.find((account) => account.id === current) : undefined;
  return {
    accounts: outside ? [...choice.accounts, outside] : choice.accounts,
    current,
    choose: (id) => {
      if (id !== current) switching.mutate({ id: thread.id, claudeAccountId: id });
    },
    blocked: switchBlocked(thread, separate, switching.isPending),
    error: switching.error?.message,
    clearError: switching.reset,
    outside: outside?.id,
    project: choice.restricted && project ? { id: project.id, name: project.name } : undefined,
    ...(shown === "other" ? { section: thread.agent } : {}),
  };
}

function switchBlocked(thread: ThreadSummary, separate: boolean, switching: boolean): string | undefined {
  if (thread.orclingId) return "An Orcling keeps its own account.";
  if (separate) return KEPT_SEPARATE.conversation;
  if (thread.activity !== "idle") return "Switch accounts when this turn ends.";
  return switching ? "Switching accounts…" : undefined;
}

/**
 * A cloud thread's accounts, where its server keeps several: the person's for the thread's agent, the one its settings
 * name checked when it is theirs, else their default. Choosing one changes what the thread's next turns run on, for
 * everyone in it; a teammate's turns run on their own default.
 */
function useCloudThreadAccounts(thread: ThreadSummary | null): PickerAccounts | undefined {
  const hosted = thread?.owner?.brain === "hosted";
  const account = useRpc("account.status", {}, { enabled: hosted }).data;
  const capabilities = useRpc("hosted.capabilities", { threadId: thread?.id ?? "" }, { enabled: hosted, staleTime: 60_000 }).data;
  const update = useRpcMutation("threads.update");
  if (!thread || !hosted || capabilities?.features.agentAccounts?.available !== true) return undefined;
  let blocked: string | undefined;
  if (thread.activity !== "idle") blocked = "Switch accounts when this turn ends.";
  else if (update.isPending) blocked = "Switching accounts…";
  const picker = cloudPicker(account, { agent: thread.agent, model: thread.model, accountId: thread.cloudAccountId }, (id) => update.mutate({ id: thread.id, patch: { cloudAccountId: id } }), blocked);
  return picker && { ...picker, error: update.error?.message, clearError: update.reset };
}

/**
 * The person's OpenOrc Cloud accounts for a picker, in their agent's section with each one's cloud usage, the one the
 * settings name checked when it is theirs, else their default. None where the server keeps one sign-in per agent.
 */
export function cloudPicker(account: AccountStatus | undefined, settings: TurnAccountSettings, choose: (id: string) => void, blocked: string | undefined): PickerAccounts | undefined {
  const { agent } = settings;
  const choices = isHarnessId(agent) ? cloudAccountChoices(account, settings) : null;
  if (!choices || !isHarnessId(agent)) return undefined;
  const { current } = choices;
  return {
    accounts: choices.accounts,
    current,
    choose: (id) => {
      if (id !== current) choose(id);
    },
    blocked,
    cloud: true,
    section: agent,
    usage: (id) => ({ provider: agent, cloud: true, cloudAccountId: id }),
    manage: "cloud",
  };
}
