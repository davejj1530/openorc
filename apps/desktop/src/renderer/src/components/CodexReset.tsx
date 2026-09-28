import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProviderUsage, RpcParams } from "@openorc/protocol";
import { Button, Dialog } from "./ui";
import { useRpcMutation } from "../lib/query";
import { formatUsageTime } from "../lib/provider-usage";

type ResetInput = RpcParams<"providers.codex.reset">;

/** Confirmation captures what the user saw; refreshed data cannot silently change its meaning. */
export function useCodexReset(report: ProviderUsage) {
  const client = useQueryClient();
  const redeem = useRpcMutation("providers.codex.reset");
  const [confirmation, setConfirmation] = useState<ProviderUsage | null>(null);
  const [retry, setRetry] = useState<ResetInput | null>(null);
  const inventory = report.resets;
  const pending = inventory?.pendingAttempt;
  const submit = async (input: ResetInput) => {
    setConfirmation(null);
    setRetry(input);
    try {
      const result = await redeem.mutateAsync(input);
      client.setQueryData(["providers.usage", { provider: "codex" }], result.usage);
      if (result.outcome !== "pending") setRetry(null);
    } catch {
      /* Keep the same attempt ID for a lost RPC response. */
    }
  };
  return {
    redeem,
    confirmation,
    submit,
    /** A lost response, or an attempt persisted before a restart, resolves under its original ID. */
    retryInput:
      retry ??
      (pending && inventory?.confirmationToken ? { attemptId: pending.id, confirmationToken: inventory.confirmationToken, ...(pending.creditId ? { creditId: pending.creditId } : {}) } : null),
    ask: () => {
      redeem.reset();
      setConfirmation(report);
    },
    dismiss: () => setConfirmation(null),
  };
}

export type CodexReset = ReturnType<typeof useCodexReset>;

export function CodexResetDialog({ reset }: { reset: CodexReset }) {
  const confirmed = reset.confirmation?.resets;
  const credit = confirmed?.credits?.[0];
  return (
    <Dialog
      open={Boolean(reset.confirmation)}
      onOpenChange={(open) => {
        if (!open) reset.dismiss();
      }}
      title="Use a Codex reset?"
    >
      <div className="space-y-3">
        <p>{reset.confirmation?.context}</p>
        <p className="text-ink-2">{credit?.description ?? "Use one available reset for eligible Codex usage limits. The provider will choose the reset when details are unavailable."}</p>
        {credit?.expiresAt != null && <p className="text-sm text-ink-2">Expires {formatUsageTime(credit.expiresAt)}</p>}
        <p className="text-sm text-ink-2">This consumes one reset and may change your next reset time. Your conversation will not restart automatically.</p>
        <div className="flex justify-end gap-2">
          <Button onClick={reset.dismiss}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!confirmed?.confirmationToken || reset.redeem.isPending}
            onClick={() => void reset.submit({ attemptId: crypto.randomUUID(), confirmationToken: confirmed!.confirmationToken!, ...(credit ? { creditId: credit.id } : {}) })}
          >
            Confirm reset
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
