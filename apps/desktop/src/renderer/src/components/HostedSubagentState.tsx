import { HOSTED_REASONS, type ThreadSummary } from "@openorc/protocol";
import { HostedControlReason } from "./HostedControlReason";
import { Button } from "./ui";

export function HostedSubagentStop({ thread, pending, onStop }: { thread: ThreadSummary; pending: boolean; onStop(): void }) {
  const child = thread.subagent;
  if (child?.status !== "running") return null;
  const reason = stopReason(thread);
  return (
    <HostedControlReason label="Stop subagent" reason={reason}>
      <Button size="sm" disabled={Boolean(reason) || pending} onClick={onStop}>
        {pending ? "Stopping…" : "Stop"}
      </Button>
    </HostedControlReason>
  );
}

function stopReason(thread: ThreadSummary): string | null {
  if (thread.owner?.reach !== "live") return "OpenOrc Cloud can't be reached.";
  return thread.subagent?.stoppable && thread.subagent.hostRunId ? null : "This subagent can't be stopped separately.";
}

export function HostedSubagentHistoryError({ error, retry }: { error: Error; retry(): void }) {
  if (error.message === HOSTED_REASONS.nativeSubthreads) {
    return (
      <HostedControlReason label="Subthread unavailable" reason={error.message}>
        <Button disabled>Subthread unavailable</Button>
      </HostedControlReason>
    );
  }
  return (
    <div className="p-4">
      <p role="alert" className="text-sm text-ink-3">
        {error.message}
      </p>
      <Button onClick={retry}>Retry loading history</Button>
    </div>
  );
}
