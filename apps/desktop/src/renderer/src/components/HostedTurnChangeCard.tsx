import { useRpc } from "../lib/client";
import { useLayout } from "../lib/layout";
import { ChangeCard } from "./ChangeCard";
import { Button } from "./ui";
import { HostedControlReason } from "./HostedControlReason";
import { HOSTED_REASONS } from "@openorc/protocol";

export function HostedTurnChangeCard({ threadId, turnId }: { threadId: string; turnId: string }) {
  const read = useRpc("hosted.review.turn", { threadId, turnId });
  const changes = read.data;
  if (read.error?.message === HOSTED_REASONS.changes)
    return (
      <HostedControlReason label="Review changes" reason={read.error.message}>
        <Button size="sm" variant="ghost" disabled>
          Review changes
        </Button>
      </HostedControlReason>
    );
  if (read.error)
    return (
      <p role="alert" className="change-error text-bad">
        {read.error.message}{" "}
        <Button size="sm" variant="ghost" onClick={() => void read.refetch()}>
          Retry
        </Button>
      </p>
    );
  if (!changes)
    return (
      <p role="status" className="text-sm text-ink-3">
        Loading changes…
      </p>
    );
  if (changes.state !== "recorded")
    return (
      <HostedControlReason label="Review changes" reason={changes.line}>
        <Button size="sm" disabled>
          Review changes
        </Button>
      </HostedControlReason>
    );
  if (!changes.totals.files) return null;
  const files = changes.files.map((file) => ({
    path: file.path,
    added: file.body.kind === "text" ? file.body.insertions : null,
    removed: file.body.kind === "text" ? file.body.deletions : null,
    ...(file.body.kind === "omitted" && { countLabel: "Not recorded" }),
  }));
  return (
    <ChangeCard
      files={files}
      counted
      totals={changes.totals}
      note={changes.unlisted ? `${changes.unlisted} more files are not listed.` : undefined}
      onReview={(paths) => useLayout.getState().openChanges({ kind: "thread", id: threadId, checkpointId: turnId, paths })}
      actions={
        <HostedControlReason label="Undo this turn's changes" reason="Restoring a cloud checkpoint isn't available yet.">
          <Button size="sm" variant="ghost" disabled>
            Undo
          </Button>
        </HostedControlReason>
      }
    />
  );
}
