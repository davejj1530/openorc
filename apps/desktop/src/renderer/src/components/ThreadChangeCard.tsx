import { useEffect, useState } from "react";
import { ChangeCard } from "./ChangeCard";
import { Button, Tooltip } from "./ui";
import { RotateCcw } from "./icons";
import { useRpc, useRpcMutation } from "../lib/query";
import { useLayout } from "../lib/layout";

/** How long an Undo waits for its confirming second click before it settles back. */
const CONFIRM_MS = 4000;

function undoDisabledReason(checkpointId: string | null, working: boolean): string | null {
  if (!checkpointId) return "No starting checkpoint was saved for this turn, so Undo is unavailable.";
  if (working) return "Wait for the current turn to finish before undoing.";
  return null;
}

function undoButtonLabel(pending: boolean, confirming: boolean): string {
  if (pending) return "Undoing…";
  if (confirming) return "Confirm undo";
  return "Undo";
}

/**
 * Undo for a turn's card and for the line between turns: a second click within a few seconds confirms, then the
 * working tree goes back to `checkpointId`. Both share it, so their Undo can't drift.
 */
export function UndoTurnButton({
  threadId,
  checkpointId,
  working,
  label,
  hint,
  confirmHint,
  onError,
}: {
  threadId: string;
  /** The checkpoint Undo restores. Null when none was saved, which leaves Undo unavailable. */
  checkpointId: string | null;
  /** A turn is running; the tree cannot be rewound under it. */
  working: boolean;
  /** The button's accessible name until it asks for confirmation. */
  label: string;
  hint: string;
  confirmHint: string;
  onError: (message: string | null) => void;
}) {
  const restore = useRpcMutation("threads.restore");
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);
  const undo = async () => {
    if (!checkpointId) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onError(null);
    try {
      const result = await restore.mutateAsync({ id: threadId, checkpointId });
      if (result) onError(result.rejected || "The restore request was rejected.");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };
  const reason = undoDisabledReason(checkpointId, working);
  return (
    <Tooltip label={reason ?? (confirming ? confirmHint : hint)}>
      <Button size="sm" variant="ghost" disabled={Boolean(reason) || restore.isPending} onClick={() => void undo()} aria-label={confirming ? "Confirm undo" : label}>
        {undoButtonLabel(restore.isPending, confirming)}
        <RotateCcw size={14} />
      </Button>
    </Tooltip>
  );
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
  /** The checkpoint this turn started from; Undo restores it. Older turns may have no starting checkpoint. */
  previousCheckpointId: string | null;
  /** Files the turn's tool calls named, shown until the saved diff is read. */
  paths: string[];
  /** A turn is running; the tree cannot be rewound under it. */
  working: boolean;
}) {
  const openReview = useLayout((state) => state.openChanges);
  const summary = useRpc("threads.turnChanges", { id: threadId, checkpointId }, { staleTime: Infinity });
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const files = summary.data?.files ?? paths.map((path) => ({ path, added: null, removed: null }));
  // A checkpoint can exist for a turn that changed nothing against its base; that turn has no card.
  if (files.length === 0) return null;
  return (
    <ChangeCard
      files={files}
      counted={Boolean(summary.data)}
      error={summary.isError ? "Change counts unavailable." : restoreError}
      onRetry={summary.isError ? () => void summary.refetch() : undefined}
      onReview={(selected) => openReview({ kind: "thread", id: threadId, checkpointId, paths: selected })}
      actions={
        <UndoTurnButton
          threadId={threadId}
          checkpointId={previousCheckpointId}
          working={working}
          label="Undo this turn's changes"
          hint="Put the files back as they were before this turn."
          confirmHint="Click again to put the files back as they were before this turn."
          onError={setRestoreError}
        />
      }
    />
  );
}
