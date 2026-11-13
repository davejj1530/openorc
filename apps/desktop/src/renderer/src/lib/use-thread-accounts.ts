import { projectAccountChoice } from "@openorc/client";
import type { Project, ThreadSummary } from "@openorc/protocol";
import type { PickerAccounts } from "../components/ModelPickerAccounts";
import { useClaudeAccountId } from "./claude-account";
import { useRpc, useRpcMutation } from "./client";

/**
 * A Claude conversation's accounts for its model picker: the project's choices, plus the thread's own when the project
 * stopped using it, so it stays listed until the thread moves. Choosing one moves the conversation between turns; the
 * next message resumes its session there. An Orcling keeps its own account.
 */
export function useThreadAccounts(thread: ThreadSummary | null, project: Pick<Project, "id" | "name" | "settings"> | null): PickerAccounts | undefined {
  const scoped = useClaudeAccountId();
  const claude = thread?.agent === "claude";
  const list = useRpc("claude.accounts.list", {}, { enabled: claude }).data;
  const switching = useRpcMutation("threads.switchClaudeAccount");
  if (!thread || !claude || !list || thread.teamInstanceId) return undefined;
  const current = scoped ?? thread.claudeAccountId ?? list.defaultId;
  const choice = projectAccountChoice(project, list);
  const outside = choice.restricted && !choice.accounts.some((account) => account.id === current) ? list.accounts.find((account) => account.id === current) : undefined;
  let blocked: string | undefined;
  if (thread.orclingId) blocked = "An Orcling keeps its own account.";
  else if (thread.activity !== "idle") blocked = "Switch accounts when this turn ends.";
  else if (switching.isPending) blocked = "Switching accounts…";
  return {
    accounts: outside ? [...choice.accounts, outside] : choice.accounts,
    current,
    choose: (id) => {
      if (id !== current) switching.mutate({ id: thread.id, claudeAccountId: id });
    },
    blocked,
    error: switching.error?.message,
    clearError: switching.reset,
    outside: outside?.id,
    project: choice.restricted && project ? { id: project.id, name: project.name } : undefined,
  };
}
