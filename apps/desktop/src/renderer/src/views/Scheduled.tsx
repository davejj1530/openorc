import { ExecutionMode, executionMode, executionModeSettings, executionModePresentation } from "@openorc/protocol";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { harnessName, type Schedule, type WorkspaceMode } from "@openorc/protocol";
import { ArrowUpRight, CalendarClock, Pause, Play, Plus, RefreshCw, Trash2, Zap } from "../components/icons";
import { ComposerModelPicker, ModelPicker } from "../components/ModelPicker";
import { TopBar } from "../components/TopBar";
import { Badge, Button, Dialog, Empty, Field, IconButton, Input, Select, Textarea, Tooltip } from "../components/ui";
import { cn } from "../lib/cn";
import { useLayout } from "../lib/layout";
import { useRpc, useRpcMutation } from "../lib/query";
import { openThread, useRouter } from "../lib/router";
import { relativeTime, untilTime } from "../lib/time";
import { useScheduleEditor } from "../lib/use-schedule-editor";
import { beginScheduleTrigger, finishScheduleTrigger, readScheduleTrigger } from "../lib/schedule-draft";

const intervals: { label: string; minutes: number }[] = [
  { label: "Every 30 minutes", minutes: 30 },
  { label: "Every hour", minutes: 60 },
  { label: "Every 6 hours", minutes: 360 },
  { label: "Every day", minutes: 1440 },
  { label: "Every week", minutes: 10_080 },
];
const intervalLabel = (m: number) => intervals.find((i) => i.minutes === m)?.label ?? `Every ${m} minutes`;

function scheduleTargetLabel(schedule: Schedule): string {
  const target = schedule.executionTarget;
  if (target?.kind === "team") {
    if (schedule.team) return `${schedule.team.revision.name} · Revision ${schedule.team.revision.number}`;
    return "Saved team · pinned revision";
  }
  if (target?.kind === "model") return target.settings.model;
  return schedule.model ?? `${harnessName(schedule.agent)} default model`;
}

function scheduleFireLabel(fire: Schedule["lastFire"]): string | null {
  switch (fire?.state) {
    case "pending":
      return "Run request pending";
    case "started":
      return "Task created";
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

function scheduleSubmitLabel(pending: boolean, existing: boolean): string {
  if (pending) return "Saving…";
  return existing ? "Save" : "Create";
}

/** Prompts that start a task on a timer with a saved model or pinned team. */
export function Scheduled() {
  const projectId = useLayout((s) => s.projectId);
  const projects = useRpc("projects.list", {});
  const list = useRpc("schedules.list", projectId ? { projectId } : {});
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const items = list.data ?? [];
  const canCreate = (projects.data?.length ?? 0) > 0;
  let listContent: ReactNode;
  if (list.isLoading) listContent = <p className="px-6 py-3 text-sm text-ink-3">Loading schedules…</p>;
  else if (!list.error && items.length === 0) {
    listContent = (
      <Empty title="Nothing scheduled">
        A schedule starts a new task with a prompt on a timer: a nightly review, a dependency check, a daily summary.
        <div className="mt-3">
          <Button onClick={() => setEditing("new")} disabled={!canCreate}>
            <Plus size={13} /> New schedule
          </Button>
        </div>
      </Empty>
    );
  } else {
    listContent = (
      <div className="flex-1 overflow-y-auto">
        {items.map((schedule) => (
          <ScheduleRow
            key={schedule.id}
            schedule={schedule}
            projectName={!projectId ? projects.data?.find((project) => project.id === schedule.projectId)?.name : undefined}
            onEdit={() => setEditing(schedule)}
          />
        ))}
      </div>
    );
  }
  return (
    <>
      <TopBar
        actions={
          <Tooltip label="New schedule">
            <IconButton aria-label="New schedule" onClick={() => setEditing("new")} disabled={!canCreate}>
              <Plus size={16} />
            </IconButton>
          </Tooltip>
        }
      >
        Scheduled
      </TopBar>
      {list.error || projects.error ? (
        <div className="px-6 py-3 text-sm text-bad" role="alert">
          {list.error?.message ?? projects.error?.message}{" "}
          <Button
            size="sm"
            onClick={() => {
              void list.refetch();
              void projects.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {listContent}
      {editing ? (
        <ScheduleDialog
          key={editing === "new" ? "new" : `${editing.id}:${editing.version}`}
          schedule={editing === "new" ? null : editing}
          latest={editing === "new" ? undefined : items.find((item) => item.id === editing.id)}
          projectId={projectId ?? projects.data?.[0]?.id ?? ""}
          onReload={setEditing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function ScheduleRow({ schedule: s, projectName, onEdit }: { schedule: Schedule; projectName?: string; onEdit: () => void }) {
  const update = useRpcMutation("schedules.update");
  const remove = useRpcMutation("schedules.delete");
  const trigger = useRpcMutation("schedules.trigger");
  const [recovery] = useState(() => {
    try {
      return { key: readScheduleTrigger(s.id), error: null };
    } catch (error) {
      return { key: null, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const [pendingKey, setPendingKey] = useState(recovery.key);
  const [localError, setLocalError] = useState<string | null>(recovery.error);
  const mounted = useRef(true);
  const requesting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const fire = s.lastFire;
  const threadId = fire?.threadId ?? s.lastThreadId;
  const targetLabel = scheduleTargetLabel(s);
  const firingLabel = scheduleFireLabel(fire);
  const error = localError ?? update.error?.message ?? remove.error?.message;
  const busy = trigger.isPending || update.isPending || remove.isPending;
  const runNow = async () => {
    if (requesting.current) return;
    requesting.current = true;
    setLocalError(null);
    try {
      const requestKey = beginScheduleTrigger(s.id);
      setPendingKey(requestKey);
      const result = await trigger.mutateAsync({ id: s.id, requestKey });
      if (!finishScheduleTrigger(s.id, requestKey)) {
        setLocalError("The run request was confirmed, but its local recovery record could not be cleared. Retry confirms the same request.");
        return;
      }
      setPendingKey(null);
      if (result.status === "failed") setLocalError(result.reason);
      if (result.status === "started" && mounted.current && useRouter.getState().route.view === "scheduled") openThread(result.thread.id);
    } catch (failure) {
      setLocalError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      requesting.current = false;
    }
  };
  return (
    <div data-schedule={s.id} className="schedule-row px-6 py-3 border-b border-line">
      <div className="flex items-center flex-wrap gap-3">
        <CalendarClock size={16} className="text-ink-3 shrink-0" />
        <button onClick={onEdit} className="flex-1 min-w-40 text-left">
          <div className={cn("text-base break-words", !s.enabled && "text-ink-2")}>{s.title}</div>
          <div className="text-sm text-ink-3 break-words tabular">
            {intervalLabel(s.everyMinutes)}
            {projectName ? ` · ${projectName}` : ""}
            {s.lastRunAt ? ` · last ${relativeTime(s.lastRunAt)}` : " · never run"}
            {s.enabled ? ` · next ${untilTime(s.nextRunAt)}` : ""}
          </div>
          <div className="text-xs text-ink-3 break-words">
            {targetLabel}
            {s.team?.archived ? " · archived team, saved revision retained" : ""}
          </div>
        </button>
        <div className="schedule-actions ml-auto flex items-center gap-1.5">
          {threadId ? (
            <Tooltip label="Open task">
              <IconButton aria-label="Open task" size="sm" onClick={() => openThread(threadId)}>
                <ArrowUpRight size={14} />
              </IconButton>
            </Tooltip>
          ) : null}
          <Badge tone={s.enabled ? "ok" : "muted"}>{s.enabled ? "on" : "off"}</Badge>
          <Tooltip label={s.enabled ? "Pause schedule" : "Resume schedule"}>
            <IconButton
              size="sm"
              aria-label={s.enabled ? "Pause schedule" : "Resume schedule"}
              disabled={busy}
              onClick={() => {
                setLocalError(null);
                update.mutate({ id: s.id, patch: { enabled: !s.enabled, expectedVersion: s.version } });
              }}
            >
              {s.enabled ? <Pause size={14} /> : <Play size={14} />}
            </IconButton>
          </Tooltip>
          <Tooltip label={pendingKey ? "Retry run request" : "Run now"}>
            <IconButton
              size="sm"
              disabled={busy}
              onClick={() => void runNow()}
              aria-label={pendingKey ? "Retry run request" : "Run now"}
              title={pendingKey ? "Confirm the saved run request without starting duplicate work" : "Run now"}
            >
              {pendingKey ? <RefreshCw size={14} /> : <Zap size={14} />}
            </IconButton>
          </Tooltip>
          <Tooltip label="Delete schedule">
            <IconButton
              size="sm"
              className="schedule-delete"
              disabled={busy || Boolean(pendingKey)}
              onClick={() => {
                setLocalError(null);
                remove.mutate({ id: s.id });
              }}
              aria-label="Delete schedule"
              title={pendingKey ? "Confirm the pending run request before deleting this schedule" : "Delete schedule"}
            >
              <Trash2 size={14} />
            </IconButton>
          </Tooltip>
        </div>
      </div>
      {firingLabel ? (
        <p className={cn("mt-2 text-xs break-words", fire?.state === "failed" ? "text-bad" : "text-ink-3")} role="status" data-schedule-firing={fire?.state}>
          {firingLabel}
          {fire?.reason ? ` · ${fire.reason}` : ""}
        </p>
      ) : null}
      {pendingKey ? <p className="mt-2 text-xs text-ink-3">A saved run request is awaiting confirmation. Retry checks that request, including its original settings.</p> : null}
      {error ? (
        <p className="mt-2 text-sm text-bad break-words" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ScheduleDialog({
  schedule,
  latest,
  projectId,
  onReload,
  onClose,
}: {
  schedule: Schedule | null;
  latest?: Schedule;
  projectId: string;
  onReload: (schedule: Schedule) => void;
  onClose: () => void;
}) {
  const {
    fields: { project, title, prompt, minutes, mode, permission, workspace },
    target: { selection: target, choice, revision, lead, currentTeam, archived, teamTarget, retainedTeam, pickerTeams, offlineMember, previewReason },
    resources: { projects, models, info, teams, availability },
    status: { pending, conflict, projectIssue, targetIssue, error, permissionReady },
    actions: { setProject, setTitle, setPrompt, setMinutes, setMode, setPermission, setWorkspace, chooseTeam, chooseModel, changeSettings, retryChecks, submit },
  } = useScheduleEditor(schedule, latest, projectId, onClose);
  const picker = <ModelPicker value={choice} onChange={chooseModel} showEffort={false} teams={pickerTeams} disabled={pending} />;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={schedule ? "Edit schedule" : "New schedule"}
      width={560}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {schedule ? (
          <p className="text-sm text-ink-3 mb-3">{projects.data?.find((item) => item.id === project)?.name ?? "Saved project"}</p>
        ) : (
          <Field label="Project">
            <Select aria-label="Schedule project" value={project} disabled={pending} onChange={(event) => setProject(event.target.value)}>
              {!projects.data?.some((item) => item.id === project) ? <option value={project}>{project ? "Unavailable project" : "Choose a project"}</option> : null}
              {(projects.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Name">
          <Input autoFocus value={title} disabled={pending} onChange={(event) => setTitle(event.target.value)} placeholder="Nightly dependency check" />
        </Field>
        <Field label="Prompt" hint="Sent as the first message of a new task each time.">
          <Textarea
            rows={4}
            value={prompt}
            disabled={pending}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Look for outdated dependencies with known vulnerabilities and propose one task per upgrade worth doing."
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Runs">
            <Select value={minutes} disabled={pending} onChange={(event) => setMinutes(Number(event.target.value))}>
              {!intervals.some((item) => item.minutes === minutes) ? <option value={minutes}>{intervalLabel(minutes)}</option> : null}
              {intervals.map((item) => (
                <option key={item.minutes} value={item.minutes}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="min-w-0 mb-3">
            <p className="text-sm text-ink-3 mb-1.5">Model or team</p>
            {choice ? (
              <ComposerModelPicker
                value={choice}
                onChange={changeSettings}
                onSelectModel={chooseModel}
                teams={pickerTeams}
                disabled={pending}
                settingsDisabled={pending}
                {...(revision && lead ? { team: { name: revision.name, revision: revision.number, leadName: lead.name } } : {})}
              />
            ) : (
              picker
            )}
            {target.kind === "legacy" && target.model === null ? <p className="text-xs text-ink-3 mt-1">{harnessName(target.agent)} provider default is saved.</p> : null}
          </div>
          <Field label="Mode">
            <Select
              value={executionMode(mode, permission)}
              disabled={pending || !permissionReady}
              onChange={(event) => {
                const next = executionModeSettings(event.target.value as ExecutionMode);
                setMode(next.mode);
                setPermission(next.permissionMode);
              }}
            >
              {ExecutionMode.options.map((value) => (
                <option key={value} value={value}>
                  {executionModePresentation(choice?.agent, value).label}
                </option>
              ))}
            </Select>
            <p className="mt-2 text-xs text-ink-3">{executionModePresentation(choice?.agent, executionMode(mode, permission)).hint}</p>
          </Field>
          {!teamTarget ? (
            <Field label="Works in">
              <Select value={workspace} disabled={pending} onChange={(event) => setWorkspace(event.target.value as WorkspaceMode)}>
                <option value="worktree">A fresh worktree</option>
                <option value="current">The checkout</option>
              </Select>
            </Field>
          ) : null}
        </div>
        {target.kind === "team" ? (
          <div className="text-xs text-ink-3 mb-3 space-y-2" data-schedule-team={target.target.teamRevisionId}>
            <p>
              {revision ? `${revision.name} · Revision ${revision.number}.` : "The exact saved team revision is retained."}{" "}
              {lead && choice
                ? `${lead.name}: ${choice.model}${choice.effort ? ` · ${choice.effort}` : ""} · ${choice.fastMode ? "Fast" : "Standard"}.`
                : "Reload team details to inspect the lead settings."}
            </p>
            <p>Each run uses isolated team workspaces. If this schedule’s previous team task is still active, the next run is skipped.</p>
            {archived && retainedTeam ? <p>This team is archived. This schedule keeps its authorized saved revision.</p> : null}
            {revision && currentTeam && !archived && currentTeam.revision.id !== revision.id ? (
              <p>
                A newer revision is available.{" "}
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => chooseTeam(currentTeam.revision)}>
                  Use revision {currentTeam.revision.number}
                </Button>
              </p>
            ) : null}
            {previewReason ? <p role="status">{previewReason} Runs check availability before starting.</p> : null}
            {offlineMember ? <p role="status">{offlineMember.name}’s provider or saved model is unavailable. The saved target is kept; readiness is checked when the schedule runs.</p> : null}
            {teams.error || models.error || info.error || availability.error ? (
              <p role="status">
                Some availability details could not refresh.{" "}
                <Button size="sm" variant="ghost" onClick={retryChecks}>
                  Retry checks
                </Button>
              </p>
            ) : null}
          </div>
        ) : null}
        {projectIssue || targetIssue ? (
          <p className="text-sm text-warn mb-3" role="status">
            {projectIssue ?? targetIssue}
          </p>
        ) : null}
        {conflict && latest ? (
          <div className="text-sm text-warn mb-3" role="status">
            This schedule changed elsewhere. Your draft is kept.{" "}
            <Button size="sm" disabled={pending} onClick={() => onReload(latest)}>
              Load saved schedule
            </Button>
          </div>
        ) : null}
        {error ? (
          <p className="text-sm text-bad mb-3 break-words" role="alert">
            {error} Your draft is kept in this editor.
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !permissionReady || Boolean(projectIssue) || Boolean(targetIssue) || !title.trim() || !prompt.trim()}>
            {scheduleSubmitLabel(pending, Boolean(schedule))}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
