import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ThreadSummary } from "@openorc/protocol";
import { arrivalGroups, arrivalRows, type ArrivalActivity, type ArrivalRow } from "./arrival-groups";
import { agentQuiet, formatQuiet, QUIET_TICK_MS } from "./agent-quiet";
import { LoaderCircle } from "./icons";
import { StatusDot } from "./ui";
import { StatusIcon, statusLabel } from "./status";
import { cn } from "../lib/cn";
import { useLayout } from "../lib/layout";
import { useRpc } from "../lib/query";
import { relativeTime } from "../lib/time";
import { openThread, useRouter } from "../lib/router";

/**
 * What is already happening, read from the two lists the shell keeps warm. The
 * method and params match the sidebar's and the rail's exactly, so react-query
 * serves this from their cache entries rather than opening a third poll.
 */
export function useArrivalActivity(): ArrivalActivity {
  const projectId = useLayout((s) => s.projectId);
  const threads = useRpc("threads.list", { ...(projectId ? { projectId } : {}), filter: "active", limit: 80 });
  const tasks = useRpc("tasks.list", {});
  const threadList = threads.data;
  const taskList = tasks.data;
  return useMemo(() => arrivalGroups(threadList ?? [], taskList ?? [], projectId), [threadList, taskList, projectId]);
}

/**
 * One clock for the whole group rather than a timer per row, and none at all
 * while nothing is ageing. The reading is always in whole minutes, so one slow
 * rate covers it; there is no fast path to leave lying around.
 */
function useQuietClock(running: ThreadSummary[]): number {
  const [now, setNow] = useState(() => Date.now());
  const newest = running.reduce<number | null>((latest, t) => (t.lastAgentEventAt === null ? latest : Math.max(latest ?? 0, t.lastAgentEventAt)), null);
  useEffect(() => {
    if (newest === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), QUIET_TICK_MS);
    return () => window.clearInterval(id);
  }, [newest]);
  return now;
}

function rowMeta(row: ArrivalRow, now: number): ReactNode {
  if (row.kind === "tasks") return "Tasks";
  if (row.kind === "waiting") return "Needs you";
  if (row.kind === "running") {
    const quiet = agentQuiet(row.thread, now);
    return quiet ? <span className={cn("tabular", quiet.strong && "text-warn")}>No output for {formatQuiet(quiet.ms)}</span> : "Working";
  }
  return relativeTime(row.thread.lastActivityAt, now);
}

function RowLead({ row }: { row: ArrivalRow }) {
  if (row.kind === "waiting") return <StatusDot tone="attention" />;
  if (row.kind === "running") return <LoaderCircle size={14} className="animate-spin" />;
  if (row.kind === "tasks") return <StatusIcon status={row.status} />;
  return null;
}

/** "Pick up where you left off": one flat list, threads that wait on you first. Every row opens the thing it names. */
export function NewThreadRecent({ activity }: { activity: ArrivalActivity }) {
  const navigate = useRouter((s) => s.navigate);
  const now = useQuietClock(activity.running);
  return (
    <section className="new-thread-recent" aria-labelledby="new-thread-recent-label">
      <h2 id="new-thread-recent-label" className="new-thread-recent-label">
        Pick up where you left off
      </h2>
      <div className="motion-stagger">
        {arrivalRows(activity).map((row) => (
          <button key={row.key} type="button" className="new-thread-recent-row motion-arrive" onClick={() => (row.kind === "tasks" ? navigate({ view: "tasks" }) : openThread(row.thread.id))}>
            <span className="new-thread-recent-lead">
              <RowLead row={row} />
            </span>
            <span className="new-thread-recent-title">
              {row.kind === "tasks" ? (
                <>
                  <span className="tabular">{row.count}</span> {statusLabel[row.status].toLowerCase()}
                </>
              ) : (
                row.thread.title
              )}
            </span>
            <span className="new-thread-recent-meta">{rowMeta(row, now)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
