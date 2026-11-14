import type { HostedThreadChanges, HostedTurnChanges } from "@openorc/protocol";
import { Button, Empty } from "./ui";

/** Only an actual empty recorded checkpoint is an empty diff. */
export function HostedReviewState({ changes, error, retry }: { changes?: HostedThreadChanges | HostedTurnChanges; error: Error | null; retry: () => void }) {
  if (error)
    return (
      <Empty title="Could not read changes">
        <p role="alert">{error.message}</p>
        <Button className="mt-3" onClick={retry}>
          Retry
        </Button>
      </Empty>
    );
  if (!changes)
    return (
      <p role="status" className="px-5 py-2.5 text-sm text-ink-3">
        Loading changes…
      </p>
    );
  if (changes.state !== "recorded") return <Empty title={changes.state === "missing" ? "Changes unavailable" : "No saved changes yet"}>{changes.line}</Empty>;
  if (!changes.totals.files) return "missing" in changes && changes.missing ? <Empty title="Changes unavailable">{changes.missing}</Empty> : <Empty title="No changes" />;
  return null;
}
