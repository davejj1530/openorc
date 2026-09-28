import { usageReportStatus, creditBalanceLabel, resetTimeLabel } from "./settings-presentation";
import { ResetControls } from "./settings-resets";
import { harnessCatalog, harnessIds, type AllowanceWindow, type ProviderUsage } from "@openorc/protocol";
import { Badge, Button } from "../components/ui";
import { ExternalLink, RefreshCw } from "../components/icons";
import { allowanceState, formatUsageTime } from "../lib/provider-usage";
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
    <>
      <p className="text-ink-2 mb-4">Allowances belong to each provider account and may include activity outside OpenOrc. Each limit is shown separately.</p>
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
      <p className="text-sm text-ink-2 mt-5">
        OpenOrc run counts are local activity, not billable tokens or subscription usage. Distillation calls are not included. Reset times use your device’s timezone.
      </p>
    </>
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
  const openUsage = () => {
    if (!d) return;
    returning.current = true;
    window.openorc.openExternal(d.accountUrl);
  };
  const stale = d?.windows.some((w) => allowanceState(w, now).stale) ?? false;
  const exhausted = d?.windows.some((w) => w.exhausted) ?? false;
  const state = usageReportStatus({ error: q.isError, fetching: q.isFetching, report: d, stale, exhausted });
  return (
    <section id={`provider-usage-${provider}`} tabIndex={-1} className="settings-provider" aria-label={`${name} usage`} aria-busy={q.isFetching}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{name}</h2>
          <p className="text-sm text-ink-2 mt-1 break-words">{d?.context ?? "Checking account…"}</p>
        </div>
        <Button disabled={q.isFetching} aria-label={`Refresh ${name} usage`} onClick={() => void q.refetch()}>
          <RefreshCw size={13} aria-hidden="true" />
          Refresh
        </Button>
      </div>
      <div className="mt-3" role="status">
        <Badge tone={q.isError || d?.status === "error" || exhausted ? "warn" : "muted"}>{state}</Badge>
      </div>
      {q.isError && (
        <p role="alert" className="text-bad mt-3">
          Could not load usage. Check your connection, then refresh. Any previous values below are out of date.
        </p>
      )}
      {!d && !q.isError && <p className="text-ink-2 py-5">Loading provider report…</p>}
      {d && (
        <>
          {d.windows.length === 0 && (
            <div className="settings-unavailable">
              <span>
                Used <strong>Unavailable</strong>
              </span>
              <span>
                Remaining <strong>Unavailable</strong>
              </span>
              <span>
                Resets <strong>Unavailable</strong>
              </span>
            </div>
          )}
          {d.windows.map((w) => (
            <UsageWindow key={w.id} value={w} now={now} />
          ))}
          {d.credits.map((c, index) => (
            <div key={`${c.label}:${index}`} className="settings-credit">
              <span className="font-medium">{c.label}</span>
              <span>{creditBalanceLabel(c)}</span>
              <span className="text-sm text-ink-2">Separate from subscription windows · used and reset unavailable</span>
            </div>
          ))}
          <ResetControls report={d} stale={q.isFetching || q.isError || d.status === "error" || d.status === "disconnected"} />
          {d.message && <p className="text-ink-2 mt-3">{d.message}</p>}
          {exhausted && <p className="text-warn mt-3">A reported limit is exhausted. Review the reset information or open your provider account for available options.</p>}
          <footer className="settings-provider-footer">
            <div className="min-w-0">
              <p>{d.source}</p>
              <p>{d.refreshedAt === null ? "No allowance report received" : `Last report ${formatUsageTime(d.refreshedAt)}`}</p>
              <p>Checked {formatUsageTime(d.checkedAt)}</p>
              {d.localRuns !== null && <p className="mt-2">{d.localRuns.toLocaleString()} runs recorded in OpenOrc · all time, this device</p>}
            </div>
            <Button variant="ghost" size="sm" className="shrink-0" onClick={openUsage}>
              Open {name === "Anthropic API" ? "Console" : "usage"}
              <ExternalLink size={12} aria-hidden="true" />
            </Button>
          </footer>
        </>
      )}
    </section>
  );
}

function UsageWindow({ value: w, now }: { value: AllowanceWindow; now: number }) {
  const { stale, expired } = allowanceState(w, now);
  const percent = (n: number | null) => (n === null ? "Unavailable" : `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`);
  return (
    <div className="settings-window">
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="font-medium">{w.label}</h3>
        {(stale || w.exhausted) && <span className="text-sm text-warn">{stale ? "Out of date" : "Limit reached"}</span>}
      </div>
      <div className="flex flex-wrap justify-between gap-2 mt-2 tabular">
        <span className="text-ink-2">{w.usedPercent === null ? "Used unavailable" : `${percent(w.usedPercent)} used`}</span>
        <span className="font-semibold">{w.remainingPercent === null ? "Remaining unavailable" : `${percent(w.remainingPercent)} remaining`}</span>
      </div>
      {w.usedPercent !== null && (
        <div
          className="settings-meter"
          role="progressbar"
          aria-label={`${w.label}: reported allowance used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, w.usedPercent)}
          style={{ ["--used" as string]: `${Math.min(100, w.usedPercent)}%` }}
        >
          <span className="settings-meter-fill" />
          <span className="settings-meter-value">{percent(w.usedPercent)} used</span>
          <span className="settings-meter-value settings-meter-value-over" aria-hidden="true">
            {percent(w.usedPercent)} used
          </span>
        </div>
      )}
      <p className="text-sm text-ink-2 mt-2 tabular">{resetTimeLabel(w.resetsAt, expired)}</p>
      {stale && <p className="text-sm text-ink-2 tabular">Reported {formatUsageTime(w.observedAt)}. Remaining allowance may have changed.</p>}
    </div>
  );
}
