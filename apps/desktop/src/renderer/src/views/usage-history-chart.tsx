import { useState } from "react";
import { harnessName, type UsageHistory } from "@openorc/protocol";
import { agentColor, bucketLabel, metricValue, usageValue, type UsageMetric, type UsagePeriod } from "./usage-history-presentation";

const width = 640;
const height = 230;

export function UsageHistoryChart({ data, metric, period }: { data: UsageHistory; metric: UsageMetric; period: UsagePeriod }) {
  const [selected, setSelected] = useState<number | null>(null);
  const maximum = Math.max(1, ...data.buckets.flatMap((bucket) => bucket.agents.map((row) => metricValue(row, metric) ?? 0)));
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const ceiling = Math.ceil(maximum / magnitude) * magnitude;
  const count = data.buckets.length;
  const x = (index: number) => (count < 2 ? width / 2 : (index / (count - 1)) * width);
  const y = (value: number) => height - (value / ceiling) * (height - 8);
  const index = selected === null ? null : Math.min(selected, count - 1);
  const bucket = index === null ? undefined : data.buckets[index];
  return (
    <section className="usage-chart" aria-label={`${period === "24h" ? "Hourly" : "Daily"} ${metric}`}>
      <h2>
        {period === "24h" ? "Hourly" : "Daily"} {metric}
      </h2>
      <div className="usage-chart-body">
        <div className="usage-chart-scale" aria-hidden="true">
          {[ceiling, ceiling / 2, 0].map((value) => (
            <span key={value}>{usageValue(value, metric)}</span>
          ))}
        </div>
        <div
          className="usage-chart-plot"
          role="group"
          tabIndex={0}
          aria-label={`${metric === "cost" ? "Cost" : "Token"} trend`}
          aria-description="Use the left and right arrow keys to inspect each period. The breakdown also lists each period."
          onFocus={() => setSelected(count - 1)}
          onBlur={() => setSelected(null)}
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setSelected(Math.max(0, Math.min(count - 1, Math.round(((event.clientX - rect.left) / rect.width) * (count - 1)))));
          }}
          onPointerLeave={() => setSelected(null)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) return;
            event.preventDefault();
            if (event.key === "Escape") setSelected(null);
            else if (event.key === "Home") setSelected(0);
            else if (event.key === "End") setSelected(count - 1);
            else setSelected(Math.max(0, Math.min(count - 1, (selected ?? count - 1) + (event.key === "ArrowLeft" ? -1 : 1))));
          }}
        >
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
            {[ceiling, ceiling / 2, 0].map((value) => (
              <line key={value} x1="0" x2={width} y1={y(value)} y2={y(value)} className="usage-chart-grid" />
            ))}
            {data.agents.map(({ agent }) => {
              const values = data.buckets.map((bucket) => {
                const row = bucket.agents.find((row) => row.agent === agent);
                return row ? metricValue(row, metric) : 0;
              });
              if (!values.some((value) => value !== null && value > 0)) return null;
              const path = values.map((value, index) => (value === null ? "" : `${index === 0 || values[index - 1] === null ? "M" : "L"}${x(index)},${y(value)}`)).join(" ");
              return (
                <g key={agent} style={{ color: agentColor(agent) }}>
                  {!values.includes(null) && <path d={`${path} L${width},${height} L0,${height} Z`} fill="currentColor" opacity="0.06" />}
                  <path d={path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                </g>
              );
            })}
            {index !== null && <line x1={x(index)} x2={x(index)} y1="0" y2={height} className="usage-chart-cursor" />}
          </svg>
          {bucket && (
            <div className="usage-chart-tooltip" role="status">
              <p>{bucketLabel(bucket.start, period)}</p>
              {data.agents.map(({ agent }) => {
                const row = bucket.agents.find((row) => row.agent === agent);
                return (
                  <div key={agent}>
                    <span>
                      <i style={{ background: agentColor(agent) }} />
                      {harnessName(agent)}
                    </span>
                    <span>{usageValue(row ? metricValue(row, metric) : 0, metric)}</span>
                  </div>
                );
              })}
              <div className="usage-chart-tooltip-total">
                <span>Total</span>
                <span>{usageValue(metricValue(bucket.total, metric), metric)}</span>
              </div>
            </div>
          )}
        </div>
        <div className="usage-chart-dates" aria-hidden="true">
          {[...new Set([0, Math.floor((count - 1) / 2), count - 1])].map((index) => (
            <span key={index}>{bucketLabel(data.buckets[index]!.start, period)}</span>
          ))}
        </div>
      </div>
    </section>
  );
}
