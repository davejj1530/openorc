import { DEFAULT_CLAUDE_ACCOUNT, type Task } from "@openorc/protocol";
import { useRpc } from "./client";

/** Why a conversation's Claude account can't change while Settings keeps accounts separate. */
export const STAYS_ON_ITS_ACCOUNT = "Accounts are kept separate, so this conversation stays on its account.";

/** Whether Settings keeps Claude accounts separate, so no conversation, and no task's work, moves to another account. */
export function useAccountsSeparate(): boolean {
  return useRpc("app.settings.get", {}).data?.claudeAccountsSeparate ?? false;
}

/**
 * While accounts are kept separate, the account a task's work stays on: its thread's, else the one of the thread it was
 * saved from. Undefined when any account will do.
 */
export function useKeptTaskAccount(task: Pick<Task, "executionThreadId" | "threadId"> | null | undefined): string | undefined {
  const separate = useAccountsSeparate();
  const owner = task?.executionThreadId ?? task?.threadId ?? null;
  const thread = useRpc("threads.get", { id: owner ?? "" }, { enabled: separate && Boolean(owner) }).data;
  return separate && owner && thread ? (thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT) : undefined;
}
