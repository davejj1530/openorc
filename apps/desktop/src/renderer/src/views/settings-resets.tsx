import type { ProviderUsage, ResetInventory } from "@openorc/protocol";
import { Button } from "../components/ui";
import { CodexResetDialog, useCodexReset, type CodexReset } from "../components/CodexReset";
import { formatUsageTime } from "../lib/provider-usage";

export function ResetControls({ report, stale }: { report: ProviderUsage; stale: boolean }) {
  const reset = useCodexReset(report);
  const inventory = report.resets ?? (report.provider === "codex" ? { availableCount: null, credits: null, redemption: "external" as const } : null);
  if (!inventory) return null;
  const { redeem } = reset;
  return (
    <div className="space-y-2">
      {report.provider === "codex" && (
        <p className="font-medium">
          {inventory.availableCount === null ? "Reset availability unknown" : `${inventory.availableCount} ${inventory.availableCount === 1 ? "reset" : "resets"} available`}
        </p>
      )}
      {inventory.credits?.map((c) => (
        <p key={c.id} className="text-sm text-ink-2">
          {c.title ?? "Usage reset"}
          {c.expiresAt !== null ? ` · Expires ${formatUsageTime(c.expiresAt)}` : " · Expiry not reported"}
        </p>
      ))}
      {inventory.message && <p className="text-sm text-ink-2">{inventory.message}</p>}
      {report.provider === "codex" && inventory.redemption === "external" && !inventory.message && (
        <p className="text-sm text-ink-2">Open your provider usage page to check for resets, or update Codex and refresh.</p>
      )}
      {report.provider === "codex" && <ResetAction inventory={inventory} reset={reset} stale={stale} />}
      {redeem.data && (
        <p role="status" className="text-sm text-ink-2">
          {redeem.data.message}
        </p>
      )}
      {redeem.isError && (
        <p role="alert" className="text-sm text-bad">
          Could not confirm the reset outcome. Retry this same attempt safely.
        </p>
      )}
      {inventory.pendingAttempt && !redeem.data && (
        <p role="status" className="text-sm text-ink-2">
          A previous reset attempt is unresolved. Retry it to check the outcome without using another reset.
        </p>
      )}
      <CodexResetDialog reset={reset} />
    </div>
  );
}

/** Codex's one reset action: retry an attempt whose outcome is unknown, or use an available reset. */
function ResetAction({ inventory, reset, stale }: { inventory: ResetInventory; reset: CodexReset; stale: boolean }) {
  const busy = reset.redeem.isPending;
  const retry = reset.retryInput;
  if (retry)
    return (
      <Button disabled={busy || stale} onClick={() => void reset.submit(retry)}>
        {busy ? "Checking reset…" : "Retry reset attempt"}
      </Button>
    );
  if (inventory.redemption !== "available" || inventory.availableCount === 0) return null;
  return (
    <Button disabled={busy || stale || !inventory.availableCount || !inventory.confirmationToken} onClick={reset.ask}>
      Use reset
    </Button>
  );
}
