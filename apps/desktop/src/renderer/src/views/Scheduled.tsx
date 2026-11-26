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
  type Automation,
  type BoardColumn,
  type Schedule,
  type WorkspaceMode,
} from "@openorc/protocol";
import { useState, type ReactNode } from "react";
import { ClaudeAccountPicker } from "../components/ClaudeAccountPicker";
import { ComposerModelPicker, ModelPicker } from "../components/ModelPicker";
import { PageFilters } from "../components/PageFilters";
import { ScopedTitle } from "../components/ScopedTitle";
import { TopBar } from "../components/TopBar";
import { Button, Dialog, Empty, Field, Input, Segmented, Select, Textarea } from "../components/ui";
import type { RulePreset } from "../lib/automation-draft";
import { useRpc } from "../lib/client";
import { focusedProject, useLayout } from "../lib/layout";
import { ClaudeAccountScope } from "../lib/claude-account";
import { useScheduleEditor, type SchedulePreset } from "../lib/use-schedule-editor";
import { AutomationDialog } from "../components/automations/AutomationDialog";
import { AutomationRow, ProposedAutomations } from "./automation-rule-rows";
import { ColumnJobRow, NewAutomationMenu, ReadyMadeAutomations } from "./automation-rows";
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
/** The form that is open: a schedule's or a rule's, each for a kept one or a new one that may start filled in. */
type Editing = { kind: "schedule"; schedule: Schedule | null; preset?: SchedulePreset | undefined } | { kind: "rule"; automation: Automation | null; preset?: RulePreset | undefined };

/**
 * The list area: loading, what agents proposed, the rows in one tile (rules, schedules, then each board's column jobs),
 * and under the active ones the ready-made automations. A tab with nothing on it says so only once there is something
 * on the other. A failed load keeps its rows.
 */
function automationListBody(input: { loading: boolean; total: number; rows: ReactNode[]; shelf: ScheduleShelf; proposed: ReactNode; readyMade: ReactNode }): ReactNode {
  if (input.loading) return <p className="px-2 py-3 text-sm text-ink-3">Loading automations…</p>;
  if (input.rows.length === 0 && input.total > 0 && input.shelf === "paused") return <Empty title="No paused automations" />;
  return (
    <div className="schedule-list flex-1 min-h-0 overflow-y-auto pb-6">
      {input.shelf === "active" ? input.proposed : null}
      {input.rows.length > 0 ? <div className="schedule-tile">{input.rows}</div> : null}
      {input.shelf === "active" ? input.readyMade : null}
    </div>
  );
}

/** The automations, schedules and column jobs of the project in scope, or of every project of the space. */
function useAutomations(projectId: string | null) {
  const spaceId = useSpaceNavigation((state) => state.current);
  const projects = useSpaceProjects(true);
  const scope = projectId ? { projectId } : {};
  const schedules = useRpc("schedules.list", scope);
  const jobs = useRpc("board.jobs", scope);
  const rules = useRpc("automations.list", scope);
  const inSpace = (id: string) => !spaceId || Boolean(projects.data?.some((project) => project.id === id));
  const queries = [schedules, jobs, rules, projects];
  return {
    projects: projects.data ?? [],
    schedules: (schedules.data ?? []).filter((schedule) => !schedule.retiredTeam && inSpace(schedule.projectId)),
    jobs: (jobs.data ?? []).filter((column) => inSpace(column.projectId)),
    rules: (rules.data ?? []).filter((automation) => inSpace(automation.projectId)),
    loading: schedules.isLoading || jobs.isLoading || rules.isLoading,
    error: queries.find((query) => query.error)?.error?.message ?? null,
    retry: () => queries.forEach((query) => void query.refetch()),
  };
}

/** Everything that starts work by itself: rules that wait for something to happen, prompts on a timer, and the agents a board's columns start, with ready-made ones to add. */
export function Scheduled() {
  const projectId = useLayout(focusedProject);
  const { projects, schedules, jobs, rules, loading, error, retry } = useAutomations(projectId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [shelf, setShelf] = useState<ScheduleShelf>("active");
  const on = shelf === "active";
  const kept = rules.filter((automation) => !automation.proposed);
  const jobsShown: BoardColumn[] = jobs.filter((column) => column.jobEnabled === on);
  const nameOf = (id: string) => (projectId ? undefined : projects.find((project) => project.id === id)?.name);
  const firstProject = projectId ?? projects[0]?.id ?? "";
  return (
    <>
      <TopBar
        actions={
          <NewAutomationMenu
            disabled={projects.length === 0}
            projectId={projectId}
            boardProjects={projects.filter((project) => project.rootPath)}
            onRule={() => setEditing({ kind: "rule", automation: null })}
            onSchedule={() => setEditing({ kind: "schedule", schedule: null })}
          />
        }
      >
        <ScopedTitle>Automations</ScopedTitle>
      </TopBar>
      <div className="page-column list-page schedules-page">
        <PageFilters tabs={<Segmented label="Automation filter" value={shelf} onChange={setShelf} options={shelfOptions} />} />
        {error ? (
          <div className="px-2 pb-3 text-sm text-bad" role="alert">
            {error}{" "}
            <Button size="sm" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : null}
        {automationListBody({
          loading,
          total: schedules.length + jobs.length + kept.length,
          rows: [
            ...kept
              .filter((automation) => automation.enabled === on)
              .map((automation) => <AutomationRow key={automation.id} automation={automation} projectName={nameOf(automation.projectId)} onEdit={() => setEditing({ kind: "rule", automation })} />),
            ...schedules
              .filter((schedule) => schedule.enabled === on)
              .map((schedule) => <ScheduleRow key={schedule.id} schedule={schedule} projectName={nameOf(schedule.projectId)} onEdit={() => setEditing({ kind: "schedule", schedule })} />),
            ...jobsShown.map((column) => <ColumnJobRow key={column.id} column={column} projectName={nameOf(column.projectId)} />),
          ],
          shelf,
          proposed: <ProposedAutomations automations={rules.filter((automation) => automation.proposed)} projectName={nameOf} />,
          readyMade: (
            <ReadyMadeAutomations
              projectId={projectId}
              projects={projects.filter((project) => project.rootPath)}
              jobs={jobs}
              rules={kept}
              onSchedule={(preset) => setEditing({ kind: "schedule", schedule: null, preset })}
              onRule={(made) => setEditing({ kind: "rule", automation: null, preset: { made } })}
            />
          ),
        })}
      </div>
      {editing?.kind === "schedule" ? (
        <ScheduleDialog
          key={editing.schedule ? `${editing.schedule.id}:${editing.schedule.version}` : `new:${editing.preset?.name ?? ""}`}
          schedule={editing.schedule}
          latest={editing.schedule ? schedules.find((item) => item.id === editing.schedule!.id) : undefined}
          projectId={firstProject}
          preset={editing.schedule ? undefined : editing.preset}
          onReload={(schedule) => setEditing({ kind: "schedule", schedule })}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {editing?.kind === "rule" ? (
        <AutomationDialog
          key={editing.automation?.id ?? `new:${editing.preset?.made?.id ?? ""}`}
          automation={editing.automation}
          projectId={firstProject}
          preset={editing.preset}
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

type ScheduleDialogProps = { schedule: Schedule | null; latest?: Schedule; projectId: string; preset?: SchedulePreset | undefined; onReload: (schedule: Schedule) => void; onClose: () => void };

function ScheduleDialog({ schedule, latest, projectId, preset, onReload, onClose }: ScheduleDialogProps) {
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
