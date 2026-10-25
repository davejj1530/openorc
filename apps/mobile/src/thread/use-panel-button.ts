import { panelToolLabels } from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { router } from "expo-router";
import { useMemo } from "react";
import { useRpc } from "../client";
import { changeDrafts } from "../changes/publishing";
import { useColors, useMode } from "../ui/mode";
import type { PanelButton } from "./PanelButton";

const toolPaths = { changes: "/changes" } as const;

/**
 * The header's side panel button for a thread with a Git project: it opens the tool last used for the thread, and
 * counts the uncommitted files beside its icon, refreshed by the thread's own pushes. Workspace threads and folders without Git
 * have no panel yet.
 */
export function usePanelButton(thread: ThreadSummary | null): PanelButton | null {
  const colors = useColors();
  const mode = useMode();
  const projectId = thread && thread.projectId !== WORKSPACE_ID ? thread.projectId : null;
  const git = useRpc("projects.git", { id: projectId ?? "" }, { enabled: projectId !== null });
  const shown = projectId !== null && git.data !== undefined && git.data !== "none";
  const threadId = thread?.id ?? "";
  const changes = useRpc("review.threadChanges", { threadId, comparison: "head" }, { enabled: shown });
  const count = changes.data?.totals.files ?? 0;
  return useMemo(
    () =>
      shown
        ? {
            // VoiceOver hears the tools the panel holds.
            label: panelToolLabels.changes,
            count,
            colors: { icon: colors.ink, count: colors["ink-2"] },
            mode,
            onPress: () => router.push({ pathname: toolPaths[changeDrafts.panelTool(threadId)], params: { threadId } }),
          }
        : null,
    [shown, count, colors, mode, threadId],
  );
}
