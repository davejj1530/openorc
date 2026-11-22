import { useMemo } from "react";
import { DEFAULT_CLAUDE_ACCOUNT, type Orcling, type Task } from "@openorc/protocol";
import { useRpc } from "./client";
import { useOrclings } from "./orclings";

export const STAYS_ON_ITS_ACCOUNT = "Accounts are kept separate, so this conversation stays on its account.";

export function useAccountsSeparate(): boolean {
  return useRpc("app.settings.get", {}).data?.claudeAccountsSeparate ?? false;
}

/** While accounts are kept separate, the account a task's work stays on: its thread's, else the one it was saved from. */
export function useKeptTaskAccount(task: Pick<Task, "executionThreadId" | "threadId"> | null | undefined): string | undefined {
  const separate = useAccountsSeparate();
  const owner = task?.executionThreadId ?? task?.threadId ?? null;
  const thread = useRpc("threads.get", { id: owner ?? "" }, { enabled: separate && Boolean(owner) }).data;
  return separate && owner && thread ? (thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT) : undefined;
}

/** The Orclings a task's work can be given to: every one, or while accounts are kept separate only those on its account. */
export function useTaskOrclings(taskId: string): Orcling[] {
  const orclings = useOrclings();
  const separate = useAccountsSeparate();
  const kept = useKeptTaskAccount(useRpc("tasks.get", { id: taskId }, { enabled: separate }).data);
  return useMemo(() => (kept ? orclings.filter((orcling) => orcling.claudeAccountId === kept) : orclings), [orclings, kept]);
}
