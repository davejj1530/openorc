import { useSpaceProjects } from "../lib/space-queries";
import { useSpaceNavigation } from "../lib/space-navigation";
import {
  ExecutionMode,
  executionMode,
  executionModeAvailable,
  executionModeNote,
  executionModePresentation,
  executionModeSettings,
  harnessName,
  type BoardJob,
  type Schedule,
  type WorkspaceMode,
} from "@openorc/protocol";
import { Menu } from "@base-ui/react/menu";
import { useState, type ReactNode } from "react";
import { ClaudeAccountPicker } from "../components/ClaudeAccountPicker";
import { Plus } from "../components/icons";
import { menuItem, menuPopup } from "../components/menu";
import { ComposerModelPicker, ModelPicker } from "../components/ModelPicker";
import { PageFilters } from "../components/PageFilters";
import { ScopedTitle } from "../components/ScopedTitle";
import { TopBar } from "../components/TopBar";
import { Button, Dialog, Empty, Field, Input, Segmented, Select, Textarea } from "../components/ui";
import { ClaudeAccountScope } from "../lib/claude-account";
import { useRpc } from "../lib/client";
import { focusedProject, useLayout } from "../lib/layout";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { useScheduleEditor, type SchedulePreset } from "../lib/use-schedule-editor";
import { ColumnJobRow, openBoard, ReadyMadeAutomations } from "./automation-rows";
import { intervalLabel, intervals, ScheduleRow } from "./schedule-row";
import "./pages.css";

function scheduleSubmitLabel(pending: boolean, existing: boolean): string {
  if (pending) return "Saving…";
  return existing ? "Save" : "Create";
}

const shelfOptions = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
] as const;

type ScheduleShelf = (typeof shelfOptions)[number]["value"];

/**
 * The list area: loading, the rows in one tile (schedules, then each board's column jobs), and under the active ones the
 * ready-made automations. A tab with nothing on it says so only once there is something on the other. A failed load keeps its rows.
 */
function automationListBody(input: { loading: boolean; total: number; rows: ReactNode[]; shelf: ScheduleShelf; readyMade: ReactNode }): ReactNode {
  if (input.loading) return <p className="px-2 py-3 text-sm text-ink-3">Loading automations…</p>;
  if (input.rows.length === 0 && input.total > 0 && input.shelf === "paused") return <Empty title="No paused automations" />;
  return (
    <div className="schedule-list flex-1 min-h-0 overflow-y-auto pb-6">
      {input.rows.length > 0 ? <div className="schedule-tile">{input.rows}</div> : null}
      {input.shelf === "active" ? input.readyMade : null}
    </div>
  );
}

/** Everything that starts work by itself: prompts on a timer, and the jobs a board's columns start, with ready-made ones to add. */
export function Scheduled() {
  const spaceId = useSpaceNavigation((state) => state.current);
  const projectId = useLayout(focusedProject);
  const projects = useSpaceProjects(true);
  const list = useRpc("schedules.list", projectId ? { projectId } : {});
  const jobList = useRpc("board.jobs", projectId ? { projectId } : {});
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [preset, setPreset] = useState<SchedulePreset | undefined>(undefined);
  const [shelf, setShelf] = useState<ScheduleShelf>("active");
  const items = (list.data ?? []).filter((schedule) => !schedule.retiredTeam && (!spaceId || projects.data?.some((project) => project.id === schedule.projectId)));
  const shown = items.filter((schedule) => schedule.enabled === (shelf === "active"));
  const jobs: BoardJob[] = (jobList.data ?? []).filter((job) => !spaceId || projects.data?.some((project) => project.id === job.column.projectId));
  const shownJobs = jobs.filter((job) => job.column.jobEnabled === (shelf === "active"));
  const canCreate = (projects.data?.length ?? 0) > 0;
  const nameOf = (id: string) => (projectId ? undefined : projects.data?.find((project) => project.id === id)?.name);
  const projectName = (schedule: Schedule) => nameOf(schedule.projectId);
  const close = () => {
    setEditing(null);
    setPreset(undefined);
  };
  return (
    <>
      <TopBar
        actions={
          <Menu.Root>
            <Menu.Trigger render={<Button variant="primary" size="lg" className="pl-2.5" disabled={!canCreate} />}>
              <Plus size={16} /> New automation
            </Menu.Trigger>
            <Menu.Portal>
              <CoversPreview />
              <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
                <Menu.Popup ref={floatingGround} className={menuPopup}>
                  <Menu.Item className={menuItem} onClick={() => setEditing("new")}>
                    <span className="flex-1">On a schedule</span>
                  </Menu.Item>
                  <Menu.Item className={menuItem} onClick={() => openBoard(projectId)}>
                    <span className="flex-1">When a card arrives in a column</span>
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        }
      >
        <ScopedTitle>Automations</ScopedTitle>
      </TopBar>
      <div className="page-column list-page schedules-page">
        <PageFilters tabs={<Segmented label="Automation filter" value={shelf} onChange={setShelf} options={shelfOptions} />} />
        {list.error || jobList.error || projects.error ? (
          <div className="px-2 pb-3 text-sm text-bad" role="alert">
            {list.error?.message ?? jobList.error?.message ?? projects.error?.message}{" "}
            <Button
              size="sm"
              onClick={() => {
                void list.refetch();
                void jobList.refetch();
                void projects.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {automationListBody({
          loading: list.isLoading || jobList.isLoading,
          total: items.length + jobs.length,
          rows: [
            ...shown.map((schedule) => <ScheduleRow key={schedule.id} schedule={schedule} projectName={projectName(schedule)} onEdit={() => setEditing(schedule)} />),
            ...shownJobs.map((job) => <ColumnJobRow key={job.column.id} job={job} projectName={nameOf(job.column.projectId)} />),
          ],
          shelf,
          readyMade: (
            <ReadyMadeAutomations
              projectId={projectId}
              projects={(projects.data ?? []).filter((project) => project.rootPath)}
              jobs={jobs}
              onSchedule={(made) => {
                setPreset(made);
                setEditing("new");
              }}
            />
          ),
        })}
      </div>
      {editing ? (
        <ScheduleDialog
          key={editing === "new" ? `new:${preset?.name ?? ""}` : `${editing.id}:${editing.version}`}
          schedule={editing === "new" ? null : editing}
          latest={editing === "new" ? undefined : items.find((item) => item.id === editing.id)}
          projectId={projectId ?? projects.data?.[0]?.id ?? ""}
          preset={editing === "new" ? preset : undefined}
          onReload={setEditing}
          onClose={close}
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
  preset,
  onReload,
  onClose,
}: {
  schedule: Schedule | null;
  latest?: Schedule;
  projectId: string;
  preset?: SchedulePreset | undefined;
  onReload: (schedule: Schedule) => void;
  onClose: () => void;
}) {
  const {
    fields: { claudeAccountId, project, title, prompt, minutes, mode, permission, workspace, worktreeBlocked },
    target: { usesClaude, selection: target, choice },
    resources: { accounts, projects },
    status: { pending, conflict, projectIssue, targetIssue, error, permissionReady },
    actions: { setAccount, setProject, setTitle, setPrompt, setMinutes, setMode, setPermission, setWorkspace, chooseModel, changeSettings, submit },
  } = useScheduleEditor(schedule, latest, projectId, onClose, preset);
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
