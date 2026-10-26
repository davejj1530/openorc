import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { useRpc } from "../client";

/**
 * The uncommitted file count under the More menu's Changes item, refreshed by the thread's own pushes; null for a
 * thread with no Changes yet: Workspace threads and folders without Git.
 */
export function useChangesCount(thread: ThreadSummary | null): number | null {
  const projectId = thread && thread.projectId !== WORKSPACE_ID ? thread.projectId : null;
  const git = useRpc("projects.git", { id: projectId ?? "" }, { enabled: projectId !== null });
  const shown = projectId !== null && git.data !== undefined && git.data !== "none";
  const changes = useRpc("review.threadChanges", { threadId: thread?.id ?? "", comparison: "head" }, { enabled: shown });
  return shown ? (changes.data?.totals.files ?? 0) : null;
}
