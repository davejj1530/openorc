import {
  ExecutionMode,
  executionMode,
  executionModeAvailable,
  executionModeNote,
  executionModePresentation,
  executionModeSettings,
  harnessName,
  type Schedule,
  type WorkspaceMode,
} from "@openorc/protocol";
import { useState, type ReactNode } from "react";
import { ClaudeAccountPicker } from "../components/ClaudeAccountPicker";
import { Plus } from "../components/icons";
import { ComposerModelPicker, ModelPicker } from "../components/ModelPicker";
import { PageFilters, PageSearch } from "../components/PageFilters";
import { TopBar } from "../components/TopBar";
import { Button, Dialog, Empty, Field, Input, Segmented, Select, Textarea } from "../components/ui";
import { ClaudeAccountScope } from "../lib/claude-account";
import { useRpc } from "../lib/client";
import { useLayout } from "../lib/layout";
import { useScheduleEditor } from "../lib/use-schedule-editor";
import { intervalLabel, intervals, ScheduleRow } from "./schedule-row";

function scheduleSubmitLabel(pending: boolean, existing: boolean): string {
  if (pending) return "Saving…";
  return existing ? "Save" : "Create";
}

const shelfOptions = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
] as const;

type ScheduleShelf = (typeof shelfOptions)[number]["value"];

/** The list area: loading, an empty state that fits the tab or search, or the rows. A failed load keeps its rows. */
function scheduleListBody(input: {
  loading: boolean;
  failed: boolean;
  total: number;
  shown: Schedule[];
  shelf: ScheduleShelf;
  query: string;
  canCreate: boolean;
  onNew: () => void;
  row: (schedule: Schedule) => ReactNode;
}): ReactNode {
  if (input.loading) return <p className="px-2 py-3 text-sm text-ink-3">Loading schedules…</p>;
  if (input.shown.length > 0 || input.failed) return <div className="schedule-list flex-1 min-h-0 overflow-y-auto pb-4">{input.shown.map(input.row)}</div>;
  if (input.query) return <Empty title="No matching schedules">Try a different name.</Empty>;
  if (input.total > 0) return <Empty title={input.shelf === "active" ? "No active schedules" : "No paused schedules"} />;
  return (
    <Empty title="Nothing scheduled">
      A schedule starts a new thread with a prompt on a timer: a nightly review, a dependency check, a daily summary.
      <div className="mt-3">
        <Button onClick={input.onNew} disabled={!input.canCreate}>
          <Plus size={13} /> New schedule
        </Button>
      </div>
    </Empty>
  );
}

/** Prompts that start a thread on a timer with a saved model. */
export function Scheduled() {
  const projectId = useLayout((s) => s.projectId);
  const projects = useRpc("projects.list", {});
  const list = useRpc("schedules.list", projectId ? { projectId } : {});
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [shelf, setShelf] = useState<ScheduleShelf>("active");
  const [query, setQuery] = useState("");
  const items = (list.data ?? []).filter((schedule) => !schedule.retiredTeam);
  const shown = items.filter((schedule) => schedule.enabled === (shelf === "active") && schedule.title.toLowerCase().includes(query.toLowerCase()));
  const canCreate = (projects.data?.length ?? 0) > 0;
  const projectName = (schedule: Schedule) => (projectId ? undefined : projects.data?.find((project) => project.id === schedule.projectId)?.name);
  return (
    <>
      <TopBar
        actions={
          <Button size="lg" onClick={() => setEditing("new")} disabled={!canCreate}>
            <Plus size={14} className="text-ink-3" /> New schedule
          </Button>
        }
      >
        Schedules
      </TopBar>
      <div className="page-column">
        <PageFilters
          tabs={<Segmented label="Schedule filter" value={shelf} onChange={setShelf} options={shelfOptions} />}
          end={<PageSearch label="Filter schedules" placeholder="Filter schedules…" value={query} onChange={setQuery} />}
        />
        {list.error || projects.error ? (
          <div className="px-2 pb-3 text-sm text-bad" role="alert">
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
        {scheduleListBody({
          loading: list.isLoading,
          failed: Boolean(list.error),
          total: items.length,
          shown,
          shelf,
          query,
          canCreate,
          onNew: () => setEditing("new"),
          row: (schedule) => <ScheduleRow key={schedule.id} schedule={schedule} projectName={projectName(schedule)} onEdit={() => setEditing(schedule)} />,
        })}
      </div>
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

/** Where a solo schedule's runs work. A worktree waits until the project can branch. */
function ScheduleWorkspaceField(props: { value: WorkspaceMode; worktreeBlocked: boolean; disabled: boolean; onChange: (value: WorkspaceMode) => void }) {
  return (
    <Field label="Works in">
      <Select value={props.value} disabled={props.disabled} onChange={(event) => props.onChange(event.target.value as WorkspaceMode)}>
        <option value="worktree" disabled={props.worktreeBlocked}>
          A fresh worktree
        </option>
        <option value="current">The checkout</option>
      </Select>
    </Field>
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
    fields: { claudeAccountId, project, title, prompt, minutes, mode, permission, workspace, worktreeBlocked },
    target: { usesClaude, selection: target, choice },
    resources: { accounts, projects },
    status: { pending, conflict, projectIssue, targetIssue, error, permissionReady },
    actions: { setAccount, setProject, setTitle, setPrompt, setMinutes, setMode, setPermission, setWorkspace, chooseModel, changeSettings, submit },
  } = useScheduleEditor(schedule, latest, projectId, onClose);
  const picker = <ModelPicker value={choice} onChange={chooseModel} showEffort={false} disabled={pending} />;

  return (
    <ClaudeAccountScope id={claudeAccountId}>
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
          {usesClaude ? <ClaudeAccountPicker accounts={accounts} value={claudeAccountId} onChange={setAccount} disabled={pending} /> : null}
          <Field label="Name">
            <Input autoFocus value={title} disabled={pending} onChange={(event) => setTitle(event.target.value)} placeholder="Nightly dependency check" />
          </Field>
          <Field label="Prompt" hint="Sent as the first message of a new thread each time.">
            <Textarea
              rows={4}
              value={prompt}
              disabled={pending}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Look for outdated dependencies with known vulnerabilities and propose one task per upgrade worth doing."
            />
          </Field>
          <div className="grid grid-cols-2 items-start gap-3">
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
              <p className="text-sm text-ink-3 mb-1.5">Model</p>
              {choice ? <ComposerModelPicker value={choice} onChange={changeSettings} onSelectModel={chooseModel} disabled={pending} settingsDisabled={pending} /> : picker}
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
                  <option key={value} value={value} hidden={!executionModeAvailable(choice?.agent, value)}>
                    {executionModePresentation(choice?.agent, value).label}
                  </option>
                ))}
              </Select>
              <p className="mt-2 text-xs text-ink-3">{executionModeNote(choice?.agent, executionMode(mode, permission))}</p>
            </Field>
            <ScheduleWorkspaceField value={workspace} worktreeBlocked={worktreeBlocked} disabled={pending} onChange={setWorkspace} />
          </div>

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
            <Button disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || !permissionReady || Boolean(projectIssue) || Boolean(targetIssue) || !title.trim() || !prompt.trim()}>
              {scheduleSubmitLabel(pending, Boolean(schedule))}
            </Button>
          </div>
        </form>
      </Dialog>
    </ClaudeAccountScope>
  );
}
