import { isSubagentThread, placeOf, type ThreadSummary } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../client";

/**
 * Compact, where the thread's place runs it: always on the Mac, and in a cloud thread once its server serves it, as on
 * the desktop. It folds the conversation so far into a summary the agent continues from; null where it cannot.
 */
export function useCompact(thread: ThreadSummary | null): (() => Promise<unknown>) | null {
  const { mutateAsync } = useRpcMutation("threads.compact");
  const cloud = Boolean(thread && placeOf(thread).elsewhere);
  const capabilities = useRpc("hosted.capabilities", { threadId: thread?.id ?? "" }, { enabled: cloud, staleTime: 60_000 });
  const served = !cloud || capabilities.data?.features.compact?.available === true;
  if (!thread || !served || isSubagentThread(thread) || thread.teamInstanceId || thread.orclingId) return null;
  return () => mutateAsync({ id: thread.id });
}
