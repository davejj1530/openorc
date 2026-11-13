import { relativeTime, untilTime } from "@openorc/client";
import { harnessName, type ModelOption, type Schedule } from "@openorc/protocol";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CalendarClock, RefreshCw, Trash2, Zap } from "../components/icons";
import { Button, IconButton, StatusDot, Switch, Tooltip } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { cn } from "../lib/cn";
import { modelLabel } from "../lib/model-effort-label";
import { openThread, useRouter } from "../lib/router";
import { beginScheduleTrigger, finishScheduleTrigger, readScheduleTrigger } from "../lib/schedule-draft";
import "./schedules.css";

export const intervals: { label: string; minutes: number }[] = [
  { label: "Every 30 minutes", minutes: 30 },
  { label: "Every hour", minutes: 60 },
  { label: "Every 6 hours", minutes: 360 },
  { label: "Every day", minutes: 1440 },
  { label: "Every week", minutes: 10_080 },
];
export const intervalLabel = (m: number) => intervals.find((i) => i.minutes === m)?.label ?? `Every ${m} minutes`;

/** The model a schedule runs, by the name the model picker gives it. */
function scheduleTargetLabel(schedule: Schedule, models: readonly ModelOption[] | undefined): string {
  const target = schedule.executionTarget;
  if (target?.kind === "model") return modelLabel(target.settings, models);
  if (!schedule.model) return `${harnessName(schedule.agent)} default model`;
  return models?.find((model) => model.agent === schedule.agent && model.id === schedule.model)?.label ?? schedule.model;
}

/** The last run as a dot and a word, and the thread to open when it failed in one. */
export function scheduleLastRun(s: Pick<Schedule, "lastFire" | "lastRunAt">, now = Date.now()): { word: string; tone: "ok" | "bad" | "muted"; failedIn: string | null } {
  const fire = s.lastFire;
  const ago = (at: number) => relativeTime(at, now);
  if (fire) {
    const at = fire.finishedAt ?? fire.createdAt;
    if (fire.state === "pending") return { word: "Starting", tone: "muted", failedIn: null };
    if (fire.state === "failed") return { word: `Failed ${ago(at)}`, tone: "bad", failedIn: fire.threadId };
    if (fire.state === "skipped") return { word: `Skipped ${ago(at)}`, tone: "muted", failedIn: null };
    if (fire.state === "cancelled") return { word: `Cancelled ${ago(at)}`, tone: "muted", failedIn: null };
    return { word: `Ran ${ago(at)}`, tone: "ok", failedIn: null };
  }
  return s.lastRunAt ? { word: `Ran ${ago(s.lastRunAt)}`, tone: "ok", failedIn: null } : { word: "Never run", tone: "muted", failedIn: null };
}

/** Run now, with a request key saved first so a retry after a crash confirms the same run instead of starting another. */
function useRunNow(id: string) {
  const trigger = useRpcMutation("schedules.trigger");
  const [recovery] = useState(() => {
    try {
      return { key: readScheduleTrigger(id), error: null };
    } catch (error) {
      return { key: null, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const [pendingKey, setPendingKey] = useState(recovery.key);
  const [error, setError] = useState<string | null>(recovery.error);
  const mounted = useRef(true);
  const requesting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const runNow = async () => {
    if (requesting.current) return;
    requesting.current = true;
    setError(null);
    try {
      const requestKey = beginScheduleTrigger(id);
      setPendingKey(requestKey);
      const result = await trigger.mutateAsync({ id, requestKey });
      if (!finishScheduleTrigger(id, requestKey)) {
        setError("The run request was confirmed, but its local recovery record could not be cleared. Retry confirms the same request.");
        return;
      }
      setPendingKey(null);
      if (result.status === "failed") setError(result.reason);
      if (result.status === "started" && mounted.current && useRouter.getState().route.view === "scheduled") openThread(result.thread.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      requesting.current = false;
    }
  };
  return { runNow, pending: trigger.isPending, pendingKey, error, setError };
}

/** How often it runs, on which model, and, across projects, in which project. */
function ScheduleWhen({ schedule: s, projectName }: { schedule: Schedule; projectName?: string | undefined }) {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 }).data;
  return <span className="schedule-when truncate">{[intervalLabel(s.everyMinutes), scheduleTargetLabel(s, models), projectName].filter(Boolean).join(" · ")}</span>;
}

/** Open the last thread, run now (or retry a saved run request) and delete. They show on hover. */
function ScheduleTools({ threadId, run, busy, retired, onDelete }: { threadId: string | null | undefined; run: ReturnType<typeof useRunNow>; busy: boolean; retired: boolean; onDelete: () => void }) {
  const retryLabel = run.pendingKey ? "Retry run request" : "Run now";
  return (
    <div className={cn("schedule-tools", run.pendingKey && "schedule-tools-shown")}>
      {threadId ? (
        <Tooltip label="Open thread">
          <IconButton aria-label="Open thread" onClick={() => openThread(threadId)}>
            <ArrowUpRight size={15} />
          </IconButton>
        </Tooltip>
      ) : null}
      <Tooltip label={retryLabel}>
        <IconButton
          disabled={busy || retired}
          onClick={() => void run.runNow()}
          aria-label={retryLabel}
          aria-description={run.pendingKey ? "Confirms the saved run request without starting duplicate work" : undefined}
        >
          {run.pendingKey ? <RefreshCw size={15} /> : <Zap size={15} />}
        </IconButton>
      </Tooltip>
      <Tooltip label="Delete schedule">
        <IconButton
          className="schedule-delete"
          disabled={busy || Boolean(run.pendingKey)}
          onClick={onDelete}
          aria-label="Delete schedule"
          aria-description={run.pendingKey ? "Confirm the pending run request before deleting this schedule" : undefined}
        >
          <Trash2 size={15} />
        </IconButton>
      </Tooltip>
    </div>
  );
}

/** Why the last run failed when it left no thread to open, a run request waiting to be confirmed, and any error, under the row. */
function ScheduleNotes({ fire, pending, error }: { fire: Schedule["lastFire"]; pending: boolean; error: string | null | undefined }) {
  const failedHere = fire?.state === "failed" && !fire.threadId && fire.reason;
  return (
    <>
      {failedHere ? (
        <p className="schedule-row-note text-bad" role="status" data-schedule-firing="failed">
          {fire.reason}
        </p>
      ) : null}
      {pending ? <p className="schedule-row-note text-ink-3">A saved run request is awaiting confirmation. Retry checks that request, including its original settings.</p> : null}
      {error ? (
        <p className="schedule-row-note text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/**
 * A schedule's row in the page's one tile: its name and how it runs, then the next run, the last run as a dot and a word,
 * the move when the last run failed in a thread, and the switch. The tools come on hover.
 */
export function ScheduleRow({ schedule: s, projectName, onEdit }: { schedule: Schedule; projectName?: string | undefined; onEdit: () => void }) {
  const update = useRpcMutation("schedules.update");
  const remove = useRpcMutation("schedules.delete");
  const run = useRunNow(s.id);
  const busy = run.pending || update.isPending || remove.isPending;
  const last = scheduleLastRun(s);
  return (
    <div data-schedule={s.id} className="schedule-row">
      <div className="schedule-row-line">
        <button type="button" onClick={onEdit} className="schedule-row-open">
          <span className="schedule-row-well" aria-hidden="true">
            <CalendarClock size={16} />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="schedule-row-name truncate">{s.title}</span>
            <ScheduleWhen schedule={s} projectName={projectName} />
          </span>
        </button>
        <ScheduleTools
          threadId={last.failedIn ? null : (s.lastFire?.threadId ?? s.lastThreadId)}
          run={run}
          busy={busy}
          retired={Boolean(s.retiredTeam)}
          onDelete={() => {
            run.setError(null);
            remove.mutate({ id: s.id });
          }}
        />
        <span className="schedule-row-next tabular text-ink-3">{s.enabled ? `Next ${untilTime(s.nextRunAt)}` : "Paused"}</span>
        <span className={cn("schedule-row-last tabular", last.tone === "bad" ? "text-bad" : "text-ink-3")}>
          <StatusDot tone={last.tone} />
          {last.word}
        </span>
        <span className="schedule-row-move">
          {last.failedIn ? (
            <Button size="sm" onClick={() => openThread(last.failedIn!)}>
              Open run
            </Button>
          ) : null}
        </span>
        <Switch
          aria-label={s.enabled ? "Pause schedule" : "Resume schedule"}
          checked={s.enabled}
          disabled={busy || Boolean(s.retiredTeam)}
          onChange={() => {
            run.setError(null);
            update.mutate({ id: s.id, patch: { enabled: !s.enabled, expectedVersion: s.version } });
          }}
        />
      </div>
      <ScheduleNotes fire={s.lastFire} pending={Boolean(run.pendingKey)} error={run.error ?? update.error?.message ?? remove.error?.message} />
    </div>
  );
}
