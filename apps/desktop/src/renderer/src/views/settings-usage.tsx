import { usageReportStatus, creditBalanceLabel } from "./settings-presentation";
import { ResetControls } from "./settings-resets";
import { harnessCatalog, harnessIds, type AllowanceWindow, type ProviderUsage } from "@openorc/protocol";
import { Button, IconButton, TextButton, Tooltip } from "../components/ui";
import { HarnessLogo } from "../components/HarnessLogo";
import { ExternalLink, RefreshCw } from "../components/icons";
import { allowanceState, formatUsageTime, usageResetLabel } from "../lib/provider-usage";
import { useEffect, useId, useRef, useState } from "react";
import { useRpc } from "../lib/query";
import { cn } from "../lib/cn";

export function ProviderUsageOverview({ active }: { active: boolean }) {
  const accounts = useRpc("claude.accounts.list", {}, { enabled: active });
  const memory = useRpc("memory.settings.get", {});
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active]);
  return (
    <div className="usage-overview">
      <div className="usage-grid">
        {harnessIds
          .filter((id) => id !== "claude")
          .map((id) => (
            <ProviderReport key={id} provider={id} name={harnessCatalog[id].name} active={active} now={now} />
          ))}
        {(accounts.data?.accounts ?? [{ id: "claude-cli", name: "Existing CLI login", enabled: true }])
          .filter((account) => account.enabled)
          .map((account) => (
            <ProviderReport key={account.id} provider="claude" claudeAccountId={account.id} name={`Claude · ${account.name}`} active={active} now={now} />
          ))}
        {(memory.data?.hasApiKey || memory.data?.provider === "apikey") && <ProviderReport provider="anthropic-api" name="Anthropic API" active={active} now={now} />}
      </div>
      {memory.isError && (
        <p className="text-bad mt-3" role="alert">
          Could not check configured API usage.{" "}
          <Button size="sm" onClick={() => void memory.refetch()}>
            Try again
          </Button>
        </p>
      )}
      <p className="usage-footnote">Each limit belongs to its provider account and may include activity outside OpenOrc. Reset times use your device’s timezone.</p>
    </div>
  );
}

/**
 * One account as a fixed-size card. The front holds the limits; Details turns the same space over
 * to the report, the provider's notes and reset options, so opening it never resizes the grid.
 * Reset controls stay mounted on the back while hidden, so an attempt's outcome survives.
 */
function ProviderReport({ provider, claudeAccountId, name, active, now }: { provider: ProviderUsage["provider"]; claudeAccountId?: string; name: string; active: boolean; now: number }) {
  const q = useRpc("providers.usage", { provider, ...(claudeAccountId ? { claudeAccountId } : {}) }, { enabled: active, staleTime: 60_000 });
  const d = q.data;
  const returning = useRef(false);
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  useEffect(() => {
    const onFocus = () => {
      if (!returning.current) return;
      returning.current = false;
      void q.refetch();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [q.refetch]);
  const stale = d?.windows.some((w) => allowanceState(w, now).stale) ?? false;
  const exhausted = d?.windows.some((w) => w.exhausted) ?? false;
  const state = usageReportStatus({ error: q.isError, fetching: q.isFetching, report: d, stale, exhausted });
  const failed = q.isError || d?.status === "error";
  // A healthy report needs no label; screen readers still hear it.
  const healthy = !failed && !q.isFetching && d?.status === "available" && !stale && !exhausted;
  return (
    <section data-usage-provider={provider} tabIndex={-1} className="usage-account" aria-label={`${name} usage`} aria-busy={q.isFetching}>
      <header className="usage-account-heading">
        <div className="usage-account-identity">
          <HarnessLogo id={provider === "anthropic-api" ? "claude" : provider} size={20} />
          <div>
            <h2>{name}</h2>
            <p title={d?.context}>{d?.context ?? "Checking account…"}</p>
          </div>
        </div>
        <div className="usage-account-status">
          <span role="status" className={cn(healthy && "sr-only")} data-warning={failed || exhausted || stale || undefined}>
            {state}
          </span>
          <Tooltip label={`Refresh ${name} usage`}>
            <IconButton size="sm" disabled={q.isFetching} aria-label={`Refresh ${name} usage`} onClick={() => void q.refetch()}>
              <RefreshCw size={14} />
            </IconButton>
          </Tooltip>
        </div>
      </header>
      <div className="usage-account-body">
        <div className={cn("usage-account-front", details && "invisible")}>
          {q.isError && (
            <p role="alert" className="text-bad">
              Couldn’t refresh. Values may be out of date.
            </p>
          )}
          {!d && !q.isError && <p className="usage-empty">Loading…</p>}
          {d && <ProviderAllowances report={d} now={now} outdated={failed || d.status === "disconnected"} />}
        </div>
        {d && (
          <div id={detailsId} className="usage-account-details" hidden={!details}>
            <UsageReportDetails report={d} stale={q.isFetching || failed || d.status === "disconnected"} />
          </div>
        )}
      </div>
      {d && (
        <footer className="usage-account-footer">
          <TextButton tone="muted" aria-expanded={details} aria-controls={detailsId} onClick={() => setDetails(!details)}>
            {details ? "Hide details" : "Details"}
          </TextButton>
          {d.accountUrl && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                returning.current = true;
                window.openorc.openExternal(d.accountUrl);
              }}
            >
              Open {d.provider === "anthropic-api" ? "Console" : "usage"}
              <ExternalLink size={12} aria-hidden="true" />
            </Button>
          )}
        </footer>
      )}
    </section>
  );
}

/** The card's front: each limit, any credit balance, and a line when a reset needs the user. */
function ProviderAllowances({ report: d, now, outdated }: { report: ProviderUsage; now: number; outdated: boolean }) {
  const resets = d.resets;
  return (
    <>
      {d.windows.length === 0 && <p className="usage-empty">{d.status === "disconnected" ? "Connect this provider to see its account allowances." : "No limits reported."}</p>}
      {d.windows.map((w) => (
        <UsageWindow key={w.id} value={w} now={now} outdated={outdated} />
      ))}
      {d.credits.map((c, index) => (
        <div key={`${c.label}:${index}`} className="usage-credit">
          <h3>{c.label}</h3>
          <strong>{creditBalanceLabel(c)}</strong>
        </div>
      ))}
      {resets?.pendingAttempt ? (
        <p className="usage-reset-note" data-warning>
          A reset attempt is unresolved
        </p>
      ) : (
        resets?.redemption === "available" &&
        Boolean(resets.availableCount) && (
          <p className="usage-reset-note">
            {resets.availableCount} {resets.availableCount === 1 ? "reset" : "resets"} available
          </p>
        )
      )}
    </>
  );
}

/** The card's back: what the report says about itself, the provider's notes, and reset options. */
function UsageReportDetails({ report: d, stale }: { report: ProviderUsage; stale: boolean }) {
  return (
    <>
      {d.windows.some((w) => w.exhausted) && <p className="text-warn">A reported limit is exhausted. Review the reset information or open your provider account for available options.</p>}
      {d.message && <p>{d.message}</p>}
      {d.credits.map((c, index) => (
        <p key={`${c.label}:${index}`}>{c.label} · separate from subscription limits · reset time unavailable</p>
      ))}
      <ResetControls report={d} stale={stale} />
      <dl className="usage-report">
        <div>
          <dt>Source</dt>
          <dd>{d.source}</dd>
        </div>
        <div>
          <dt>Last report</dt>
          <dd>{d.refreshedAt === null ? "Not received" : formatUsageTime(d.refreshedAt)}</dd>
        </div>
        {d.checkedAt !== d.refreshedAt && (
          <div>
            <dt>Checked</dt>
            <dd>{formatUsageTime(d.checkedAt)}</dd>
          </div>
        )}
        {d.localRuns !== null && (
          <div>
            <dt>Local activity</dt>
            <dd>{d.localRuns.toLocaleString()} runs · all time, this device</dd>
          </div>
        )}
      </dl>
      {d.localRuns !== null && <p>Local runs are not billable tokens or subscription usage. Distillation calls are excluded.</p>}
    </>
  );
}

/** One row: a ring for the reported amount, the limit over its reset time, and the amount itself. */
function UsageWindow({ value: w, now, outdated }: { value: AllowanceWindow; now: number; outdated: boolean }) {
  const stale = outdated || allowanceState(w, now).stale;
  const amount = w.remainingPercent ?? w.usedPercent;
  const metric = w.remainingPercent !== null ? "remaining" : "used";
  const percent = amount === null ? null : amount.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const filled = amount === null ? 0 : Math.max(0, Math.min(100, amount));
  const ring = (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle className="usage-ring-track" cx="16" cy="16" r="13" />
      {filled > 0 && <circle className="usage-ring-fill" cx="16" cy="16" r="13" pathLength="100" strokeDasharray={`${filled} 100`} />}
    </svg>
  );
  return (
    <div className="usage-window" data-warning={w.exhausted || stale || undefined}>
      {amount === null ? (
        <span className="usage-ring">{ring}</span>
      ) : (
        <span
          className="usage-ring"
          role="progressbar"
          aria-label={`${w.label}: reported allowance ${metric}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={filled}
          aria-valuetext={`${percent}% ${metric}${stale ? ", out of date" : ""}`}
        >
          {ring}
        </span>
      )}
      <div className="usage-window-label">
        <h3>{w.label}</h3>
        <p title={w.resetsAt === null ? undefined : formatUsageTime(w.resetsAt)}>{stale ? `Out of date · reported ${formatUsageTime(w.observedAt)}` : usageResetLabel(w.resetsAt, now)}</p>
      </div>
      <span className="usage-window-value">{percent === null ? "Not reported" : `${percent}% ${metric === "remaining" ? "left" : "used"}`}</span>
    </div>
  );
}
