import { HOSTED_REASONS, hostedThreadOf } from "@openorc/protocol";
import { HostedControlReason } from "./HostedControlReason";
import { Button } from "./ui";

export function hostedOutputUnavailable(block: { outputOmitted?: boolean; runId?: string }): boolean {
  return Boolean(block.outputOmitted && block.runId && hostedThreadOf(block.runId));
}

export function HostedToolOutput() {
  return (
    <HostedControlReason label="Full output" reason={HOSTED_REASONS.toolOutput}>
      <Button size="sm" variant="ghost" disabled>
        Full output
      </Button>
    </HostedControlReason>
  );
}
