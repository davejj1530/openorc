import { useEffect, useState } from "react";
import { ChangeCard } from "./ChangeCard";
import { Button, Tooltip } from "./ui";
import { RotateCcw } from "./icons";
import { useRpc, useRpcMutation } from "../lib/query";
import { useLayout } from "../lib/layout";

/** How long an Undo waits for its confirming second click before it settles back. */
const CONFIRM_MS = 4000;

function undoDisabledReason(previousCheckpointId: string | null, working: boolean): string | null {
  if (!previousCheckpointId) return "This is the thread's first checkpoint; there is nothing earlier to return to.";
  if (working) return "Wait for the current turn to finish before undoing.";
  return null;
}

function undoButtonLabel(pending: boolean, confirming: boolean): string {
  if (pending) return "Undoing…";
  if (confirming) return "Confirm undo";
  return "Undo";
}

/**
 * What one thread turn changed, under the reply that made it. The paths from the
 * turn's tool calls show at once; the saved checkpoint diff fills in the counts.
 * Undo puts the working tree back to the checkpoint before this turn.
 */
export function ThreadChangeCard({
  threadId,
  checkpointId,
  previousCheckpointId,
  paths,
  working,
}: {
  threadId: string;
  checkpointId: string;
  /** The checkpoint this turn started from; Undo restores it. Absent for the first turn. */
  previousCheckpointId: string | null;
  /** Files the turn's tool calls named, shown until the saved diff is read. */
  paths: string[];
  /** A turn is running; the tree cannot be rewound under it. */
  working: boolean;
}) {
  const openReview = useLayout((state) => state.openChanges);
  const summary = useRpc("threads.turnChanges", { id: threadId, checkpointId }, { staleTime: Infinity });
  const restore = useRpcMutation("threads.restore");
  const [confirming, setConfirming] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);
  const files = summary.data?.files ?? paths.map((path) => ({ path, added: null, removed: null }));
  // A checkpoint can exist for a turn that changed nothing against its base; that turn has no card.
  if (files.length === 0) return null;
  const undo = async () => {
    if (!previousCheckpointId) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setRestoreError(null);
    try {
      const result = await restore.mutateAsync({ id: threadId, checkpointId: previousCheckpointId });
      if (result) setRestoreError(result.rejected || "The restore request was rejected.");
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : String(error));
    }
  };
  const undoReason = undoDisabledReason(previousCheckpointId, working);
  return (
    <ChangeCard
      files={files}
      counted={Boolean(summary.data)}
      error={summary.isError ? "Change counts unavailable." : restoreError}
      onRetry={summary.isError ? () => void summary.refetch() : undefined}
      onReview={(selected) => openReview({ kind: "thread", id: threadId, checkpointId, paths: selected })}
      actions={
        <Tooltip label={undoReason ?? (confirming ? "Click again to put the files back as they were before this turn." : "Put the files back as they were before this turn.")}>
          <Button size="sm" variant="ghost" disabled={Boolean(undoReason) || restore.isPending} onClick={() => void undo()} aria-label={confirming ? "Confirm undo" : "Undo this turn's changes"}>
            {undoButtonLabel(restore.isPending, confirming)}
            <RotateCcw size={14} />
          </Button>
        </Tooltip>
      }
    />
  );
}
