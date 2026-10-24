import { useEffect, useRef, useState } from "react";
import { harnessName, type Schedule } from "@openorc/protocol";
import { ArrowUpRight, CalendarClock, RefreshCw, Trash2, Zap } from "../components/icons";
import { IconButton, Switch, Tooltip } from "../components/ui";
import { cn } from "../lib/cn";
import { useRpcMutation } from "../lib/client";
import { openThread, useRouter } from "../lib/router";
import { relativeTime, untilTime } from "@openorc/client";
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

function scheduleTargetLabel(schedule: Schedule): string {
  const target = schedule.executionTarget;
  if (target?.kind === "team") {
    if (schedule.team) return `${schedule.team.revision.name} · Version ${schedule.team.revision.number}`;
    return "Saved team · pinned version";
  }
  if (target?.kind === "model") return target.settings.model;
  return schedule.model ?? `${harnessName(schedule.agent)} default model`;
}

function scheduleFireLabel(fire: Schedule["lastFire"]): string | null {
  switch (fire?.state) {
    case "pending":
      return "Run request pending";
    case "started":
      return "Thread started";
    case "skipped":
      return "Run skipped";
    case "cancelled":
      return "Run cancelled";
    case "failed":
      return "Run failed";
    default:
      return null;
  }
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

/**
 * When the schedule runs, said in place: the next run while it is on, or that it is paused. Flipping the switch swaps
 * one line for the other.
 */
function ScheduleWhen({ schedule: s, projectName }: { schedule: Schedule; projectName?: string | undefined }) {
  const details = [scheduleTargetLabel(s), projectName, s.lastRunAt ? `last ${relativeTime(s.lastRunAt)}` : "never run", s.team?.archived ? "archived team, saved version kept" : null];
  return (
    <span className="schedule-when">
      <span className="motion-swap shrink-0">
        <span aria-hidden={!s.enabled}>{`${intervalLabel(s.everyMinutes)}, next ${untilTime(s.nextRunAt)}`}</span>
        <span aria-hidden={s.enabled}>{`${intervalLabel(s.everyMinutes)}, paused`}</span>
      </span>
      <span className="truncate">{`· ${details.filter(Boolean).join(" · ")}`}</span>
    </span>
  );
}

/** Open the last thread, run now (or retry a saved run request) and delete. They show on hover. */
function ScheduleTools({ threadId, run, busy, onDelete }: { threadId: string | null | undefined; run: ReturnType<typeof useRunNow>; busy: boolean; onDelete: () => void }) {
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
          disabled={busy}
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

/** What happened to the last run, a run request waiting to be confirmed, and any error, under the row. */
function ScheduleNotes({ fire, pending, error }: { fire: Schedule["lastFire"]; pending: boolean; error: string | null | undefined }) {
  const firingLabel = scheduleFireLabel(fire);
  return (
    <>
      {firingLabel ? (
        <p className={cn("schedule-card-note", fire?.state === "failed" && "text-bad")} role="status" data-schedule-firing={fire?.state}>
          {firingLabel}
          {fire?.reason ? ` · ${fire.reason}` : ""}
        </p>
      ) : null}
      {pending ? <p className="schedule-card-note">A saved run request is awaiting confirmation. Retry checks that request, including its original settings.</p> : null}
      {error ? (
        <p className="schedule-card-note text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

export function ScheduleRow({ schedule: s, projectName, onEdit }: { schedule: Schedule; projectName?: string | undefined; onEdit: () => void }) {
  const update = useRpcMutation("schedules.update");
  const remove = useRpcMutation("schedules.delete");
  const run = useRunNow(s.id);
  const busy = run.pending || update.isPending || remove.isPending;
  return (
    <div data-schedule={s.id} data-plane className="schedule-row schedule-card">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onEdit} className="schedule-card-open">
          <span className="schedule-card-well" aria-hidden="true">
            <CalendarClock size={16} />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="schedule-card-name truncate">{s.title}</span>
            <ScheduleWhen schedule={s} projectName={projectName} />
          </span>
        </button>
        <ScheduleTools
          threadId={s.lastFire?.threadId ?? s.lastThreadId}
          run={run}
          busy={busy}
          onDelete={() => {
            run.setError(null);
            remove.mutate({ id: s.id });
          }}
        />
        <Switch
          aria-label={s.enabled ? "Pause schedule" : "Resume schedule"}
          checked={s.enabled}
          disabled={busy}
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
