import type { ProviderUsage } from "@openorc/protocol";
import { Button } from "../components/ui";
import { CodexResetDialog, useCodexReset } from "../components/CodexReset";
import { formatUsageTime } from "../lib/provider-usage";

export function ResetControls({ report, stale }: { report: ProviderUsage; stale: boolean }) {
  const reset = useCodexReset(report);
  const inventory = report.resets ?? (report.provider === "codex" ? { availableCount: null, credits: null, redemption: "external" as const } : null);
  if (!inventory) return null;
  const { redeem, retryInput } = reset;
  const busy = redeem.isPending;
  return (
    <div className="mt-4 space-y-2">
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
      {report.provider === "codex" &&
        (retryInput ? (
          <Button disabled={busy || stale} onClick={() => void reset.submit(retryInput)}>
            {busy ? "Checking reset…" : "Retry reset attempt"}
          </Button>
        ) : (
          inventory.redemption === "available" && (
            <Button disabled={busy || stale || !inventory.availableCount || !inventory.confirmationToken} onClick={reset.ask}>
              Use reset
            </Button>
          )
        ))}
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
