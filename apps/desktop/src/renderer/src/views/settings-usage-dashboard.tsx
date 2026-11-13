import { useEffect, useMemo, useRef, useState } from "react";
import { harnessIds, harnessName, isHarnessId, type HarnessId, type UsageHistory, type UsageTotals } from "@openorc/protocol";
import { HarnessLogo } from "../components/HarnessLogo";
import { RefreshCw } from "../components/icons";
import { Button, IconButton, Segmented, Select, Tooltip } from "../components/ui";
import { useRpc } from "../lib/client";
import { swapInPlace } from "../lib/motion";
import { useRouter } from "../lib/router";
import { ProviderUsageOverview } from "./settings-usage";
import { UsageHistoryChart } from "./usage-history-chart";
import {
  agentColor,
  bucketLabel,
  formatTokens,
  metricValue,
  processedTokens,
  secondaryUsage,
  usageBoundaries,
  usagePeriods,
  usageShare,
  usageValue,
  type UsageMetric,
  type UsagePeriod,
} from "./usage-history-presentation";
import "./settings-usage-dashboard.css";

type UsageView = UsageMetric | "limits";
const views = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "limits", label: "Limits" },
] satisfies { value: UsageView; label: string }[];

export function UsageDashboard({ active }: { active: boolean }) {
  const route = useRouter((state) => state.route);
  const provider = route.view === "settings" && route.section === "usage" ? route.provider : undefined;
  const [view, setView] = useState<UsageView>(provider ? "limits" : "cost");
  const [period, setPeriod] = useState<UsagePeriod>("30d");
  const [agent, setAgent] = useState<HarnessId | undefined>();
  const [now, setNow] = useState(Date.now);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && provider) setView("limits");
  }, [active, provider]);
  const boundaries = useMemo(() => usageBoundaries(period, now), [period, now]);
  const query = useRpc("usage.history", { boundaries, ...(agent ? { agent } : {}) }, { enabled: active && view !== "limits", placeholderData: (previous) => previous });
  // Re-entering Usage or a manual refresh includes activity since the last visit.
  useEffect(() => {
    if (active && !wasActive.current) setNow(Date.now());
    wasActive.current = active;
  }, [active]);
  return (
    <div className="usage-dashboard">
      <div className="usage-dashboard-toolbar">
        {view !== "limits" && (
          <div className="usage-dashboard-filters">
            <Select aria-label="Filter usage by agent" value={agent ?? "all"} onChange={(event) => setAgent(isHarnessId(event.target.value) ? event.target.value : undefined)}>
              <option value="all">All agents</option>
              {harnessIds.map((id) => (
                <option key={id} value={id}>
                  {harnessName(id)}
                </option>
              ))}
            </Select>
            <Segmented label="Usage period" size="sm" value={period} options={usagePeriods} onChange={setPeriod} />
          </div>
        )}
        <div className="usage-dashboard-views">
          <Segmented label="Usage view" size="sm" value={view} options={views} onChange={(value) => swapInPlace("usage-view", () => setView(value))} />
          {view !== "limits" && (
            <Tooltip label="Refresh usage">
              <IconButton aria-label="Refresh usage" disabled={query.isFetching} onClick={() => setNow(Date.now())}>
                <RefreshCw size={16} />
              </IconButton>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="usage-dashboard-content" hidden={view !== "limits"}>
        <ProviderUsageOverview active={active && view === "limits"} />
      </div>
      {view !== "limits" && (
        <div className="usage-dashboard-content" aria-busy={query.isFetching}>
          {query.isError && (
            <p className="usage-dashboard-message" role="alert">
              Couldn’t load usage.{" "}
              <Button size="sm" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </p>
          )}
          {!query.data && !query.isError && (
            <p className="usage-dashboard-message" role="status">
              Loading usage…
            </p>
          )}
          {query.data && <UsageHistoryContent data={query.data} metric={view} period={period} onAgent={setAgent} />}
        </div>
      )}
    </div>
  );
}

export function UsageHistoryContent({ data, metric, period, onAgent }: { data: UsageHistory; metric: UsageMetric; period: UsagePeriod; onAgent: (agent: HarnessId) => void }) {
  const value = metricValue(data.total, metric);
  const agents = [...data.agents].sort((a, b) => (metricValue(b, metric) ?? -1) - (metricValue(a, metric) ?? -1));
  return (
    <>
      <div className="usage-dashboard-overview">
        <section className="usage-dashboard-summary" aria-label="Usage total">
          <div className="usage-dashboard-total" data-unreported={value === null || undefined}>
            {usageValue(value, metric)}
          </div>
          <p className="usage-dashboard-context">
            {data.total.sessions.toLocaleString()} {data.total.sessions === 1 ? "session" : "sessions"} · {metric === "cost" ? "API estimate" : "Processed tokens"}
          </p>
          {metric === "cost" && data.total.unpricedSessions > 0 && (
            <p className="usage-dashboard-coverage">
              Cost unavailable for {data.total.unpricedSessions.toLocaleString()} {data.total.unpricedSessions === 1 ? "session" : "sessions"}
            </p>
          )}
          {metric === "tokens" && data.total.unreportedTokenSessions > 0 && (
            <p className="usage-dashboard-coverage">
              Tokens not reported for {data.total.unreportedTokenSessions.toLocaleString()} {data.total.unreportedTokenSessions === 1 ? "session" : "sessions"}
            </p>
          )}
          <div className="usage-agent-list">
            {agents.map((row) => (
              <button type="button" className="usage-agent-row" key={row.agent} onClick={() => onAgent(row.agent)} aria-label={`Show ${harnessName(row.agent)} usage`}>
                <i className="usage-agent-dot" style={{ background: agentColor(row.agent) }} />
                <div className="usage-agent-description">
                  <div className="usage-agent-name">
                    <HarnessLogo id={row.agent} size={18} />
                    <span>{harnessName(row.agent)}</span>
                    <span className="usage-agent-sessions">
                      {row.sessions.toLocaleString()} {row.sessions === 1 ? "session" : "sessions"}
                    </span>
                  </div>
                  <p>{[usageShare(metricValue(row, metric), value), secondaryUsage(row, metric)].filter(Boolean).join(" · ")}</p>
                </div>
                <span className="usage-agent-value">{usageValue(metricValue(row, metric), metric)}</span>
              </button>
            ))}
          </div>
        </section>
        <UsageHistoryChart key={`${metric}:${period}`} data={data} metric={metric} period={period} />
      </div>
      {data.total.sessions === 0 ? (
        <p className="usage-dashboard-message">No recorded activity in this period.</p>
      ) : (
        <>
          <UsageTokenTotals total={data.total} />
          <UsageBreakdown data={data} metric={metric} period={period} />
        </>
      )}
      <p className="usage-dashboard-footnote">
        API cost estimates for activity recorded by this OpenOrc installation, including on subscription plans. Codex uses recorded tokens and published model prices.
      </p>
    </>
  );
}

function UsageTokenTotals({ total }: { total: UsageTotals }) {
  const entries = [
    { label: "Cached input", value: total.cacheReadTokens, color: "var(--ink-3)" },
    { label: "Uncached input", value: total.inputTokens, color: "var(--ink-4)" },
    { label: "Cache write", value: total.cacheWriteTokens, color: "var(--ink-2)" },
    { label: "Output", value: total.outputTokens, color: "var(--ink)" },
  ];
  const count = processedTokens(total);
  const measured = metricValue(total, "tokens") !== null;
  return (
    <section className="usage-token-totals" aria-label="Token totals">
      <h2>Totals</h2>
      <dl>
        <div>
          <dt>Processed tokens</dt>
          <dd data-tip={measured ? count.toLocaleString() : "Not reported"}>{measured ? formatTokens(count) : "—"}</dd>
        </div>
        {entries.map(({ label, value }) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd data-tip={measured ? value.toLocaleString() : "Not reported"}>{measured ? formatTokens(value) : "—"}</dd>
          </div>
        ))}
      </dl>
      {count > 0 && (
        <div className="usage-token-composition">
          <div className="usage-token-track" aria-hidden="true">
            {entries.map(({ label, value, color }) => (
              <span key={label} style={{ flex: value, background: color }} />
            ))}
          </div>
          <div className="usage-token-legend">
            {entries.map(({ label, value, color }) => (
              <span key={label}>
                <i style={{ background: color }} />
                {label} <span>{usageShare(value, count)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function UsageBreakdown({ data, metric, period }: { data: UsageHistory; metric: UsageMetric; period: UsagePeriod }) {
  const [by, setBy] = useState<"model" | "day">("model");
  const periodLabel = period === "24h" ? "Hour" : "Day";
  const rows =
    by === "model"
      ? [...data.models]
          .sort((a, b) => (metricValue(b, metric) ?? -1) - (metricValue(a, metric) ?? -1))
          .map((row) => ({ ...row, key: `${row.agent}:${row.model}`, label: row.model ?? "Model not reported" }))
      : [...data.buckets].reverse().map((bucket) => ({ ...bucket.total, key: String(bucket.start), label: bucketLabel(bucket.start, period), agent: null }));
  return (
    <section className="usage-breakdown" aria-label="Usage breakdown">
      <header>
        <h2>Breakdown</h2>
        <Segmented
          label="Breakdown by"
          size="sm"
          value={by}
          options={[
            { value: "model", label: "Model" },
            { value: "day", label: period === "24h" ? "Hour" : "Day" },
          ]}
          onChange={(value) => swapInPlace("usage-breakdown", () => setBy(value))}
        />
      </header>
      <div className="usage-breakdown-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{by === "model" ? "Model" : periodLabel}</th>
              <th scope="col">{metric === "cost" ? "Cost" : "Tokens"}</th>
              <th scope="col">Share</th>
              <th scope="col">{metric === "cost" ? "Tokens" : "Cost"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">
                  <span>
                    {row.agent && <HarnessLogo id={row.agent} size={16} />}
                    <span data-tip={row.label}>{row.label}</span>
                  </span>
                </th>
                <td>{usageValue(metricValue(row, metric), metric)}</td>
                <td>{usageShare(metricValue(row, metric), metricValue(data.total, metric)) || "—"}</td>
                <td>{usageValue(metricValue(row, metric === "cost" ? "tokens" : "cost"), metric === "cost" ? "tokens" : "cost")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
