import { usageReportStatus, creditBalanceLabel } from "./settings-presentation";
import { ResetControls } from "./settings-resets";
import { harnessCatalog, harnessIds, type AllowanceWindow, type ProviderUsage } from "@openorc/protocol";
import { Button, IconButton, Tooltip } from "../components/ui";
import { HarnessLogo } from "../components/HarnessLogo";
import { ExternalLink, RefreshCw } from "../components/icons";
import { allowanceState, formatUsageTime, usageResetLabel } from "../lib/provider-usage";
import { useEffect, useRef, useState } from "react";
import { useRpc } from "../lib/query";

export function ProviderUsageOverview({ active }: { active: boolean }) {
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
      {harnessIds.map((id) => (
        <ProviderReport key={id} provider={id} name={harnessCatalog[id].name} active={active} now={now} />
      ))}
      {(memory.data?.hasApiKey || memory.data?.provider === "apikey") && <ProviderReport provider="anthropic-api" name="Anthropic API" active={active} now={now} />}
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

function ProviderReport({ provider, name, active, now }: { provider: ProviderUsage["provider"]; name: string; active: boolean; now: number }) {
  const q = useRpc("providers.usage", { provider }, { enabled: active, staleTime: 60_000 });
  const d = q.data;
  const returning = useRef(false);
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
  return (
    <section id={`provider-usage-${provider}`} tabIndex={-1} className="usage-account" aria-label={`${name} usage`} aria-busy={q.isFetching}>
      <header className="usage-account-heading">
        <div className="usage-account-identity">
          <HarnessLogo id={provider === "anthropic-api" ? "claude" : provider} size={26} />
          <div>
            <h2>{name}</h2>
            <p>{d?.context ?? "Checking account…"}</p>
          </div>
        </div>
        <div className="usage-account-status">
          <span role="status" data-warning={failed || exhausted || stale || undefined}>
            {state}
          </span>
          <Tooltip label={`Refresh ${name} usage`}>
            <IconButton disabled={q.isFetching} aria-label={`Refresh ${name} usage`} onClick={() => void q.refetch()}>
              <RefreshCw size={14} />
            </IconButton>
          </Tooltip>
        </div>
      </header>
      {q.isError && (
        <p role="alert" className="text-bad mt-3">
          Could not load usage. Check your connection, then refresh. Any previous values below are out of date.
        </p>
      )}
      {!d && !q.isError && <p className="usage-empty">Loading provider report…</p>}
      {d && (
        <>
          <ProviderAllowances report={d} now={now} outdated={failed || d.status === "disconnected"} />
          <UsageReportDetails
            report={d}
            stale={q.isFetching || failed || d.status === "disconnected"}
            openUsage={() => {
              returning.current = true;
              window.openorc.openExternal(d.accountUrl);
            }}
          />
        </>
      )}
    </section>
  );
}

function ProviderAllowances({ report: d, now, outdated }: { report: ProviderUsage; now: number; outdated: boolean }) {
  return (
    <>
      {d.windows.length === 0 && (
        <p className="usage-empty">{d.status === "disconnected" ? "Connect this provider to see its account allowances." : "This provider hasn’t reported any account limits."}</p>
      )}
      <div className="usage-windows">
        {d.windows.map((w) => (
          <UsageWindow key={w.id} value={w} now={now} outdated={outdated} />
        ))}
      </div>
      {d.credits.map((c, index) => (
        <div key={`${c.label}:${index}`} className="usage-credit">
          <div>
            <h3>{c.label}</h3>
            <p>Separate from subscription limits · reset time unavailable</p>
          </div>
          <strong>{creditBalanceLabel(c)}</strong>
        </div>
      ))}
      {d.message && <p className="usage-message">{d.message}</p>}
      {d.windows.some((w) => w.exhausted) && <p className="text-warn mt-3">A reported limit is exhausted. Review the reset information or open your provider account for available options.</p>}
    </>
  );
}

function UsageReportDetails({ report: d, stale, openUsage }: { report: ProviderUsage; stale: boolean; openUsage: () => void }) {
  return (
    <>
      <ResetControls report={d} stale={stale} disclosure />
      <footer className="usage-account-footer">
        <details className="usage-report-details">
          <summary>Report details</summary>
          <dl>
            <div>
              <dt>Source</dt>
              <dd>{d.source}</dd>
            </div>
            <div>
              <dt>Last report</dt>
              <dd>{d.refreshedAt === null ? "Not received" : formatUsageTime(d.refreshedAt)}</dd>
            </div>
            <div>
              <dt>Checked</dt>
              <dd>{formatUsageTime(d.checkedAt)}</dd>
            </div>
            {d.localRuns !== null && (
              <div>
                <dt>Local activity</dt>
                <dd>{d.localRuns.toLocaleString()} runs · all time, this device</dd>
              </div>
            )}
          </dl>
          {d.localRuns !== null && <p>Local runs are not billable tokens or subscription usage. Distillation calls are excluded.</p>}
        </details>
        {d.accountUrl && (
          <Button variant="ghost" size="sm" onClick={openUsage}>
            Open {d.provider === "anthropic-api" ? "Console" : "usage"}
            <ExternalLink size={12} aria-hidden="true" />
          </Button>
        )}
      </footer>
    </>
  );
}

function UsageWindow({ value: w, now, outdated }: { value: AllowanceWindow; now: number; outdated: boolean }) {
  const stale = outdated || allowanceState(w, now).stale;
  const amount = w.remainingPercent ?? w.usedPercent;
  const metric = w.remainingPercent !== null ? "remaining" : "used";
  const percent = amount === null ? null : amount.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return (
    <div className="usage-window" data-warning={w.exhausted || stale || undefined}>
      <div className="usage-window-label">
        <h3>{w.label}</h3>
        <p title={w.resetsAt === null ? undefined : formatUsageTime(w.resetsAt)}>{usageResetLabel(w.resetsAt, now)}</p>
      </div>
      <div className="usage-window-meter">
        {amount !== null && (
          <div
            className="usage-meter"
            role="progressbar"
            aria-label={`${w.label}: reported allowance ${metric}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.max(0, Math.min(100, amount))}
            aria-valuetext={`${percent}% ${metric}${stale ? ", out of date" : ""}`}
          >
            <span style={{ width: `${Math.max(0, Math.min(100, amount))}%` }} />
          </div>
        )}
        {(stale || w.exhausted) && <span className="usage-window-warning">{stale ? "Out of date · refresh to update" : "Limit reached"}</span>}
      </div>
      <div className="usage-window-value">
        {percent === null ? (
          <span>Not reported</span>
        ) : (
          <>
            <strong>
              {percent}
              <small>%</small>
            </strong>
            <span>{metric}</span>
          </>
        )}
      </div>
      {stale && <p className="usage-window-observed">Reported {formatUsageTime(w.observedAt)}. Allowance may have changed.</p>}
    </div>
  );
}
