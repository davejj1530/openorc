import { isSubagentThread, type ThreadSummary } from "@openorc/protocol";
import { useRpc } from "../client";

/** How many of a thread's subthreads one read lists. */
export const SUBTHREAD_PAGE = 100;

/** The subthreads directly under `parentId` among listed rows, newest first; a native subagent shows in the transcript instead. */
export function subthreadsOf(rows: readonly ThreadSummary[] | undefined, parentId: string): ThreadSummary[] {
  return (rows ?? []).filter((row) => row.parentThreadId === parentId && !isSubagentThread(row)).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The threads started from this one, by the person or its agent: its own family as the thread list reads it, the
 * thread selected so its children come whatever page it is on, resolved ones included.
 */
export function useSubthreads(thread: Pick<ThreadSummary, "id" | "projectId"> | null): { subthreads: ThreadSummary[]; loading: boolean } {
  const read = useRpc(
    "threads.list",
    { projectId: thread?.projectId, filter: "all", includeChildren: true, limit: 1, selectedId: thread?.id, childLimits: thread ? { [thread.id]: SUBTHREAD_PAGE } : {} },
    { enabled: Boolean(thread) },
  );
  return { subthreads: thread ? subthreadsOf(read.data, thread.id) : [], loading: read.isLoading };
}
