import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ThreadSummary } from "@openorc/protocol";
import { arrivalGroups, type ArrivalActivity } from "./arrival-groups";
import { agentQuiet, formatQuiet, QUIET_TICK_MS } from "./agent-quiet";
import { MessageSquare } from "./icons";
import { StatusIcon, statusLabel } from "./status";
import { cn } from "../lib/cn";
import { useLayout } from "../lib/layout";
import { useRpc } from "../lib/query";
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

/** A live dot in the app's existing vocabulary: warn wants you, accent is working. */
function Dot({ tone }: { tone: "warn" | "accent" }) {
  return <span className={cn("w-1.5 h-1.5 rounded-full", tone === "warn" ? "bg-warn" : "bg-accent animate-pulse")} />;
}

function Row({ icon, title, meta, onClick }: { icon: ReactNode; title: ReactNode; meta?: ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-2.5 h-7 -mx-2 px-2 rounded-md text-left text-base text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink">
      <span className="w-3.5 shrink-0 grid place-items-center">{icon}</span>
      <span className="flex-1 min-w-0 truncate">{title}</span>
      {meta ? <span className="shrink-0 text-sm whitespace-nowrap">{meta}</span> : null}
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h2 className="mb-1 text-sm font-medium text-ink-3">{label}</h2>
      {children}
    </section>
  );
}

/** Every row opens the thing it names; nothing here is a statistic for its own sake. */
export function ArrivalPanel({ activity }: { activity: ArrivalActivity }) {
  const navigate = useRouter((s) => s.navigate);
  const now = useQuietClock(activity.running);
  return (
    <div className="mt-8 grid gap-5 min-w-0">
      {activity.waiting.length > 0 ? (
        <Group label="Needs you">
          {activity.waiting.map((t) => (
            <Row key={t.id} icon={<Dot tone="warn" />} title={t.title} onClick={() => openThread(t.id)} />
          ))}
        </Group>
      ) : null}
      {activity.running.length > 0 ? (
        <Group label="Working">
          {activity.running.map((t) => {
            const quiet = agentQuiet(t, now);
            return (
              <Row
                key={t.id}
                icon={<Dot tone="accent" />}
                title={t.title}
                meta={quiet ? <span className={cn("tabular", quiet.strong ? "text-warn" : "text-ink-4")}>no output for {formatQuiet(quiet.ms)}</span> : null}
                onClick={() => openThread(t.id)}
              />
            );
          })}
        </Group>
      ) : null}
      {activity.tasks.length > 0 ? (
        <Group label="Tasks">
          {activity.tasks.map((group) => (
            <Row
              key={group.status}
              icon={<StatusIcon status={group.status} />}
              title={
                <>
                  <span className="tabular">{group.count}</span> {statusLabel[group.status].toLowerCase()}
                </>
              }
              onClick={() => navigate({ view: "tasks" })}
            />
          ))}
        </Group>
      ) : null}
      {activity.recent.length > 0 ? (
        <Group label="Recent">
          {activity.recent.map((t) => (
            <Row key={t.id} icon={<MessageSquare size={13} className="text-ink-4" />} title={t.title} onClick={() => openThread(t.id)} />
          ))}
        </Group>
      ) : null}
    </div>
  );
}
