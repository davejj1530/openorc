import { useMemo } from "react";
import type { ComposerChanges } from "../components/Composer";
import { patchStat, publishView, teamGitActions, type GitActions, type PublishInput } from "@openorc/client";
import { useLayout, type WorkspaceChangesTarget } from "./layout";
import { useRpc } from "./client";
import { useThreadMutationPending } from "./thread-mutations";

type ComposerSource = WorkspaceChangesTarget & { projectName: string; team?: boolean; thread?: PublishInput["thread"] };

/** The composer offers only Commit, so the push and pull request inputs stay empty. */
const commitOnly = { project: { gitRemote: null, defaultBranch: null }, push: { state: undefined, error: null }, gh: undefined, offline: null } as const;

/** Why the composer's Commit waits: publishView's reason for a thread, the agent's work among them. */
function commitReason(source: ComposerSource, { failed, files, team, pending }: { failed: boolean; files: number; team: GitActions; pending: boolean }): string | null {
  let reason: string | null;
  if (source.thread) reason = publishView({ ...commitOnly, thread: source.thread, uncommitted: failed ? "failed" : { files }, team, running: null }).commit?.reason ?? null;
  else if (failed) reason = "Refresh changes before committing.";
  else reason = team.commit.allowed ? null : team.commit.reason;
  return reason ?? (source.team && pending ? "Wait for the current workspace action to finish." : null);
}

/** The composer and review panel share these cache entries; only uncommitted work belongs in the strip. */
export function useComposerChanges(source: ComposerSource | null): ComposerChanges | null {
  const threadId = source?.kind === "thread" ? source.id : "";
  const threadDiff = useRpc("review.threadDiff", { threadId, comparison: "head" }, { enabled: Boolean(threadId) });
  const projectDiff = useRpc("review.projectDiff", { projectId: source?.kind === "project" ? source.id : "" }, { enabled: source?.kind === "project" });
  const runtime = useRpc("orchestration.runtime", { threadId }, { enabled: Boolean(threadId && source?.team), refetchInterval: 8000 });
  const pending = useThreadMutationPending(threadId);
  const diff = source?.kind === "thread" ? threadDiff : projectDiff;
  const counts = useMemo(() => patchStat(diff.data?.patch ?? ""), [diff.data?.patch]);
  if (!source) return null;
  const files = diff.data?.files.length ?? 0;
  const commitDisabledReason = commitReason(source, { failed: diff.isError, files, team: teamGitActions(Boolean(source.team), runtime), pending });
  return {
    projectName: source.projectName,
    files,
    ...counts,
    error: diff.error ? "Could not refresh workspace changes." : null,
    onRetry: () => {
      void diff.refetch();
    },
    onReview: () => useLayout.getState().openWorkspaceChanges({ kind: source.kind, id: source.id }),
    onCommit: () => useLayout.getState().openWorkspaceChanges({ kind: source.kind, id: source.id }, "commit"),
    commitDisabledReason,
  };
}
