import { isSubagentThread, type ThreadSummary } from "@openorc/protocol";
import { useRpcMutation } from "../client";
import { useServed } from "./served";

/**
 * Compact, where the thread's place runs it: always on the Mac, and in a cloud thread once its server serves it, as on
 * the desktop. It folds the conversation so far into a summary the agent continues from; null where it cannot.
 */
export function useCompact(thread: ThreadSummary | null): (() => Promise<unknown>) | null {
  const { mutateAsync } = useRpcMutation("threads.compact");
  const served = useServed(thread, "compact");
  if (!thread || !served || isSubagentThread(thread) || thread.teamInstanceId || thread.orclingId) return null;
  return () => mutateAsync({ id: thread.id });
}
