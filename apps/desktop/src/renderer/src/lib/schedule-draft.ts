import { normalizeModelSettings } from "@openorc/protocol";
import { ModelExecutionSettings, type AgentKind, type ExecutionTarget, type RpcResults, type Schedule, type TeamRevision } from "@openorc/protocol";
import type { ModelChoice, TeamPickerChoices } from "../components/ModelPicker";

export type ScheduleTarget =
  | { kind: "unselected" }
  | { kind: "legacy"; agent: AgentKind; model: string | null; effort: string | null }
  | { kind: "model"; settings: ModelExecutionSettings }
  | { kind: "team"; target: Extract<ExecutionTarget, { kind: "team" }>; projectId: string; revision: TeamRevision | null; archived: boolean };

/** Editing an old schedule must not replace a provider default or pinned revision. */
export function scheduleTarget(schedule: Schedule | null): ScheduleTarget {
  if (!schedule) return { kind: "unselected" };
  if (schedule.executionTarget?.kind === "team")
    return { kind: "team", target: schedule.executionTarget, projectId: schedule.projectId, revision: schedule.team?.revision ?? null, archived: Boolean(schedule.team?.archived) };
  if (schedule.executionTarget?.kind === "model") return { ...schedule.executionTarget, settings: normalizeModelSettings(schedule.executionTarget.settings) };
  return { kind: "legacy", ...normalizeModelSettings({ agent: schedule.agent, model: schedule.model, effort: schedule.effort }) };
}

export function scheduleTargetChoice(target: ScheduleTarget): ModelChoice | null {
  if (target.kind === "model") return target.settings;
  if (target.kind === "legacy") return target.model ? { agent: target.agent, model: target.model, effort: target.effort } : null;
  if (target.kind !== "team") return null;
  const lead = target.revision?.members.find((member) => member.managerKey === null);
  return lead ? normalizeModelSettings({ ...lead.settings, ...target.target.initialLeadOverrides }) : null;
}

export function scheduleModelTarget(choice: ModelChoice): ScheduleTarget {
  return { kind: "model", settings: normalizeModelSettings(ModelExecutionSettings.parse({ ...choice, fastMode: Boolean(choice.fastMode) })) };
}

export function scheduleTeamTarget(revision: TeamRevision): ScheduleTarget {
  return { kind: "team", target: { kind: "team", teamRevisionId: revision.id, initialLeadOverrides: {} }, projectId: revision.projectId, revision, archived: false };
}

export function scheduleTargetSettings(target: ScheduleTarget, selected: ModelChoice): ScheduleTarget {
  return target.kind === "team" ? { ...target, target: { ...target.target, initialLeadOverrides: { effort: selected.effort, fastMode: Boolean(selected.fastMode) } } } : scheduleModelTarget(selected);
}

/** Report compatibility without replacing a saved model or pinned team revision. */
export function scheduleDraftIssue(
  project: string,
  availableProjects: readonly string[] | undefined,
  target: ScheduleTarget,
  archived: boolean,
  retainedTeam: boolean,
  teamBlocker: string | null = null,
) {
  let projectIssue: string | null = null;
  if (!project) projectIssue = "Choose a project.";
  else if (availableProjects && !availableProjects.includes(project)) projectIssue = "This project is unavailable. Choose an available project.";

  let targetIssue: string | null = null;
  if (target.kind === "team" && target.projectId !== project) targetIssue = "The selected team belongs to another project. Choose a team for this project or select a model.";
  else if (archived && !retainedTeam) targetIssue = "The selected team was archived. Restore it or choose another target.";
  else if (target.kind === "team" && teamBlocker) targetIssue = teamBlocker;
  else if (target.kind === "unselected") targetIssue = "Choose a model or saved team.";
  return { projectIssue, targetIssue };
}

export function scheduleTargetPayload(target: ScheduleTarget, projectId: string) {
  if (target.kind === "unselected") throw new Error("Choose a model or saved team.");
  if (target.kind === "legacy") return { executionTarget: null, agent: target.agent, model: target.model, effort: target.effort };
  if (target.kind === "team") {
    if (target.projectId !== projectId) throw new Error("The selected team belongs to another project. Choose a team for this project or select a model.");
    return { executionTarget: target.target, workspaceMode: "worktree" as const };
  }
  return { executionTarget: { kind: "model" as const, settings: target.settings } };
}

const triggerKey = (id: string) => `openorc.draft.schedule.${id}.trigger`;

export function readScheduleTrigger(id: string): string | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(triggerKey(id));
  } catch {
    throw new Error("Could not read the saved run request. Restore local storage before running this schedule.");
  }
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && "requestKey" in value && typeof value.requestKey === "string" && value.requestKey.trim() && value.requestKey.length <= 300)
      return value.requestKey;
  } catch {
    /* Never replace an unreadable, possibly accepted request with a new key. */
  }
  throw new Error("The saved run request could not be read. It is retained to prevent duplicate work.");
}

export function beginScheduleTrigger(id: string, createKey: () => string = () => crypto.randomUUID()): string {
  const previous = readScheduleTrigger(id);
  if (previous) return previous;
  const requestKey = createKey();
  try {
    localStorage.setItem(triggerKey(id), JSON.stringify({ requestKey }));
  } catch {
    throw new Error("Could not save this run request for recovery. Restore local storage and retry; no run was requested.");
  }
  return requestKey;
}

export function finishScheduleTrigger(id: string, requestKey: string): boolean {
  try {
    if (readScheduleTrigger(id) !== requestKey) return false;
    localStorage.removeItem(triggerKey(id));
    return true;
  } catch {
    return false;
  }
}

/** The saved teams a schedule can pick. In a project that can't run teams yet, each one says why. */
export function scheduleTeamChoices(input: {
  teams: { data: RpcResults["orchestration.list"] | undefined; isError: boolean; isPending: boolean };
  target: ScheduleTarget;
  teamBlocker: string | null;
  onSelect: (revision: TeamRevision) => void;
  retry: () => void;
}): TeamPickerChoices {
  const { teams, target } = input;
  const active = (teams.data ?? []).filter((item) => item.team.archivedAt === null);
  let status: string | null = input.teamBlocker;
  if (teams.isError) status = "Saved teams could not load. The current selection is kept.";
  else if (teams.isPending) status = "Loading teams…";
  else if (active.length === 0) status = "No active teams in this project.";
  return {
    options: active.map((item) => ({
      teamId: item.team.id,
      revisionId: item.revision.id,
      name: item.revision.name,
      revision: item.revision.number,
      memberCount: item.revision.members.length,
      disabledReason: input.teamBlocker,
    })),
    ...(target.kind === "team" ? { selectedRevisionId: target.target.teamRevisionId, selectedLabel: target.revision?.name ?? "Saved team" } : {}),
    onSelect: (id) => {
      const selected = teams.data?.find((item) => item.revision.id === id);
      if (selected) input.onSelect(selected.revision);
    },
    status,
    ...(teams.isError ? { action: { label: "Retry team list", onSelect: input.retry } } : {}),
  };
}
