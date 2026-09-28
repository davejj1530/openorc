import type { ReactNode } from "react";
import type { ProviderUsage } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { useRpc } from "../lib/query";
import { useRouter } from "../lib/router";
import { CodexResetDialog, useCodexReset } from "./CodexReset";

type Provider = "codex" | "claude";

/**
 * Recovery where a limit surfaced. A reset the provider reports is one
 * confirmation away; anything else is handled in usage settings.
 */
export function UsageRecovery({ provider, lead, className }: { provider: Provider; lead?: string; className?: string }) {
  return <div className={cn("my-2 text-sm text-ink-2", className)}>{provider === "codex" ? <CodexRecovery lead={lead} /> : <RecoveryLine lead={lead} provider={provider} />}</div>;
}

function CodexRecovery({ lead }: { lead?: string }) {
  const q = useRpc("providers.usage", { provider: "codex" }, { staleTime: 60_000 });
  if (!q.data) return <RecoveryLine lead={lead} provider="codex" />;
  const stale = q.isFetching || q.isError || q.data.status === "error" || q.data.status === "disconnected";
  return <CodexResetOffer report={q.data} stale={stale} lead={lead} />;
}

function CodexResetOffer({ report, stale, lead }: { report: ProviderUsage; stale: boolean; lead?: string }) {
  const reset = useCodexReset(report);
  const { redeem, retryInput } = reset;
  const inventory = report.resets;
  const used = redeem.data?.outcome === "reset" || redeem.data?.outcome === "alreadyRedeemed";
  const count = !used && inventory?.redemption === "available" && inventory.confirmationToken ? (inventory.availableCount ?? 0) : 0;
  const disabled = redeem.isPending || stale;
  let resetAction: ReactNode = null;
  if (retryInput) {
    resetAction = (
      <button type="button" className="text-accent-ink hover:underline disabled:text-ink-4" disabled={disabled} onClick={() => void reset.submit(retryInput)}>
        {redeem.isPending ? "Checking reset…" : "Retry reset attempt"}
      </button>
    );
  } else if (count > 0) {
    resetAction = (
      <>
        <button type="button" className="text-accent-ink hover:underline disabled:text-ink-4" disabled={disabled} onClick={reset.ask}>
          Use reset
        </button>{" "}
        ({count} available)
      </>
    );
  }
  return (
    <>
      <RecoveryLine lead={lead} provider="codex">
        {resetAction}
      </RecoveryLine>
      {redeem.data && <p role="status">{used ? "Reset used. Send a message to continue." : redeem.data.message}</p>}
      {redeem.isError && (
        <p role="alert" className="text-bad">
          Could not confirm the reset outcome. Retry this same attempt safely.
        </p>
      )}
      <CodexResetDialog reset={reset} />
    </>
  );
}

function RecoveryLine({ lead, provider, children }: { lead?: string; provider: Provider; children?: ReactNode }) {
  return (
    <p>
      {lead ? `${lead} ` : null}
      {children ? <>{children} · </> : null}
      <button type="button" className="text-accent-ink hover:underline" onClick={() => useRouter.getState().navigate({ view: "settings", section: "usage", provider })}>
        Manage usage
      </button>
    </p>
  );
}
