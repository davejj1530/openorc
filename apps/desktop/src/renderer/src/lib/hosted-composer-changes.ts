import type { ThreadSummary } from "@openorc/protocol";
import { sendsBlocked } from "@openorc/client";
import type { ComposerChanges } from "../components/Composer";
import { useRpc } from "./client";
import { useLayout } from "./layout";

/** The server knows whether there is dirty work, but does not report its file count. */
export function useHostedComposerChanges(thread: ThreadSummary | null, projectName: string): (ComposerChanges & { uncounted: true }) | null {
  const id = thread?.id ?? "";
  const read = useRpc("hosted.review.state", { threadId: id }, { enabled: Boolean(thread) });
  const inPanel = useLayout((state) => state.panelOpen && state.panelTab === "changes" && (!state.panelThreadId || state.panelThreadId === id));
  if (!thread || read.error || !read.data?.work.uncommitted) return null;
  return {
    projectName,
    files: 0,
    insertions: 0,
    deletions: 0,
    uncounted: true,
    inPanel,
    commitDisabledReason: sendsBlocked(thread) ?? (read.data.actions.length ? "Wait for the current action to finish." : null),
    onRetry: () => void read.refetch(),
    onReview: () => useLayout.getState().openWorkspaceChanges({ kind: "thread", id }),
    onCommit: () => useLayout.getState().openWorkspaceChanges({ kind: "thread", id }, "commit"),
  };
}
