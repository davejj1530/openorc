import { useMemo } from "react";
import type { ComposerChanges } from "../components/Composer";
import { patchStat } from "../components/diff-stat";
import { useLayout, type WorkspaceChangesTarget } from "./layout";
import { useRpc } from "./query";
import { teamGitActions } from "./team-git-actions";
import { useThreadMutationPending } from "./thread-mutations";

/** The composer and review panel share these cache entries; only uncommitted work belongs in the strip. */
export function useComposerChanges(source: (WorkspaceChangesTarget & { projectName: string; team?: boolean }) | null): ComposerChanges | null {
  const threadId = source?.kind === "thread" ? source.id : "";
  const threadDiff = useRpc("review.threadDiff", { threadId, comparison: "head" }, { enabled: Boolean(threadId) });
  const projectDiff = useRpc("review.projectDiff", { projectId: source?.kind === "project" ? source.id : "" }, { enabled: source?.kind === "project" });
  const runtime = useRpc("orchestration.runtime", { threadId }, { enabled: Boolean(threadId && source?.team), refetchInterval: 8000 });
  const pending = useThreadMutationPending(threadId);
  const diff = source?.kind === "thread" ? threadDiff : projectDiff;
  const counts = useMemo(() => patchStat(diff.data?.patch ?? ""), [diff.data?.patch]);
  if (!source) return null;
  const commit = teamGitActions(Boolean(source.team), runtime).commit;
  let commitDisabledReason: string | null = null;
  if (diff.isError) commitDisabledReason = "Refresh changes before committing.";
  else if (!commit.allowed) commitDisabledReason = commit.reason;
  else if (source.team && pending) commitDisabledReason = "Wait for the current workspace action to finish.";
  return {
    projectName: source.projectName,
    files: diff.data?.files.length ?? 0,
    ...counts,
    error: diff.error ? "Could not refresh workspace changes." : null,
    onRetry: () => {
      void diff.refetch();
    },
    onReview: () => useLayout.getState().openWorkspaceChanges(source),
    onCommit: () => useLayout.getState().openWorkspaceChanges(source, "commit"),
    commitDisabledReason,
  };
}
