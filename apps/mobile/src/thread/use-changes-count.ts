import { placeOf, WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { useRpc } from "../client";

/**
 * The file count under the More menu's Changes item, refreshed by the thread's own pushes: the uncommitted files of a
 * thread of this Mac, a cloud thread's branch as OpenOrc Cloud recorded it. Null for a thread with no Changes yet:
 * Workspace threads and folders without Git.
 */
export function useChangesCount(thread: ThreadSummary | null): number | null {
  const cloud = Boolean(thread && placeOf(thread).elsewhere);
  const branch = useRpc("hosted.review.changes", { threadId: thread?.id ?? "" }, { enabled: cloud });
  const projectId = !cloud && thread && thread.projectId !== WORKSPACE_ID ? thread.projectId : null;
  const git = useRpc("projects.git", { id: projectId ?? "" }, { enabled: projectId !== null });
  const shown = projectId !== null && git.data !== undefined && git.data !== "none";
  const changes = useRpc("review.threadChanges", { threadId: thread?.id ?? "", comparison: "head" }, { enabled: shown });
  if (cloud) return branch.data?.state === "recorded" ? branch.data.totals.files : 0;
  return shown ? (changes.data?.totals.files ?? 0) : null;
}
