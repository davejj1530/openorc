import { useEffect, useMemo, useState } from "react";
import { DiffView } from "../components/DiffView";
import { TopBar } from "../components/TopBar";
import { Button, Input } from "../components/ui";
import { core } from "../lib/rpc";
import { startStats, useStats } from "../lib/stats";
import { makeSyntheticPatch } from "../lib/synthetic";
import type { AppMetrics } from "../../../shared/types";

/** Phase 0's harness, kept as a screen so the CI benchmark has a home. Development and QA builds only. */
export function Diagnostics() {
  const stats = useStats();
  const [metrics, setMetrics] = useState<AppMetrics | null>(null);
  const [runs, setRuns] = useState(5);
  const [rate, setRate] = useState(5000);
  const [seconds, setSeconds] = useState(10);
  const [diffLines, setDiffLines] = useState(10_000);
  const [showDiff, setShowDiff] = useState(false);
  const [firstPaint, setFirstPaint] = useState<number | null>(null);
  const patch = useMemo(() => (showDiff ? makeSyntheticPatch(diffLines) : ""), [showDiff, diffLines]);

  useEffect(() => {
    startStats();
    const id = setInterval(async () => setMetrics(await window.openorc.metrics()), 2000);
    return () => clearInterval(id);
  }, []);

  const totalMb = metrics ? Math.round(metrics.processes.reduce((a, p) => a + p.workingSetKb, 0) / 1024) : null;

  return (
    <div className="h-full flex flex-col min-h-0">
      <TopBar>Diagnostics</TopBar>
      <div className="flex gap-6 px-6 py-2 border-b border-line text-sm font-mono text-ink-2">
        <span>bridge {stats.connected ? `up, mcp :${stats.mcpPort}` : "connecting"}</span>
        <span>cold start {metrics?.coldStartMs ?? "…"} ms</span>
        <span>working set {totalMb ?? "…"} MB</span>
        <span>events/s {stats.last.events}</span>
        <span>frames/s {stats.last.frames}</span>
        <span className={stats.last.longFrames > 0 ? "text-warn" : ""}>long frames/s {stats.last.longFrames}</span>
        <span>total events {stats.eventsReceived}</span>
      </div>
      <div className="flex-1 min-h-0 flex">
        <aside className="w-72 shrink-0 border-r border-line p-4 grid gap-4 content-start overflow-y-auto">
          <section className="grid gap-2">
            <h2 className="text-xs font-medium text-ink-3 uppercase tracking-wide">Bridge bench</h2>
            <label className="text-sm text-ink-3">
              runs <Input type="number" value={runs} onChange={(e) => setRuns(Number(e.target.value))} />
            </label>
            <label className="text-sm text-ink-3">
              events/s <Input type="number" value={rate} onChange={(e) => setRate(Number(e.target.value))} />
            </label>
            <label className="text-sm text-ink-3">
              seconds <Input type="number" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
            </label>
            <div className="flex gap-2">
              <Button variant="primary" size="sm" onClick={() => core.call("bench.start", { runs, eventsPerSecond: rate, durationMs: seconds * 1000 })}>
                Start
              </Button>
              <Button size="sm" onClick={() => core.call("bench.stop", {})}>
                Stop
              </Button>
            </div>
            {stats.benchResult ? (
              <div className="text-xs font-mono text-ink-3">
                sent {stats.benchResult.eventsSent} events in {stats.benchResult.framesSent} frames over {stats.benchResult.durationMs} ms
              </div>
            ) : null}
          </section>
          <section className="grid gap-2">
            <h2 className="text-xs font-medium text-ink-3 uppercase tracking-wide">Diff viewer</h2>
            <label className="text-sm text-ink-3">
              changed lines <Input type="number" value={diffLines} onChange={(e) => setDiffLines(Number(e.target.value))} />
            </label>
            <Button size="sm" onClick={() => setShowDiff((v) => !v)}>
              {showDiff ? "Hide diff" : "Render synthetic diff"}
            </Button>
            {firstPaint !== null && showDiff ? <div className="text-xs font-mono text-ink-3">first paint {firstPaint} ms</div> : null}
          </section>
          <section className="grid gap-1">
            <h2 className="text-xs font-medium text-ink-3 uppercase tracking-wide">Processes</h2>
            {metrics?.processes.map((p) => (
              <div key={p.pid} className="text-xs font-mono text-ink-3">
                {p.type}
                {p.name ? ` ${p.name}` : ""}: {Math.round(p.workingSetKb / 1024)} MB
              </div>
            ))}
          </section>
        </aside>
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {showDiff ? (
            <div className="flex-1 min-h-0">
              <DiffView patch={patch} onFirstPaint={setFirstPaint} />
            </div>
          ) : (
            <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-ink-3 whitespace-pre-wrap">{stats.logs.join("\n") || "Core log is empty."}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
