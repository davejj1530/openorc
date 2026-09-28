import { useEffect, useState } from "react";
import { harnessInfo, harnessLoggedIn, isHarnessId, type RunMode, type Schedule, type TeamRevision, type WorkspaceMode } from "@openorc/protocol";
import { defaultChoice, type ModelChoice } from "../components/ModelPicker";
import { usePermissionSelection } from "./permission-default";
import { branchingReason, useProjectGit } from "./project-git";
import { useRpc, useRpcMutation } from "./query";
import {
  scheduleDraftIssue,
  scheduleModelTarget,
  scheduleTarget,
  scheduleTargetChoice,
  scheduleTargetPayload,
  scheduleTargetSettings,
  scheduleTeamChoices,
  scheduleTeamTarget,
} from "./schedule-draft";

/** What the chosen project's git allows: until it can branch, a schedule works in the project folder. */
function useScheduleGit(project: string, chosen: WorkspaceMode) {
  const { state, cannotBranch } = useProjectGit(project);
  return { cannotBranch, workspace: cannotBranch ? ("current" as const) : chosen, teamReason: branchingReason(state, "Teams") };
}

/** Owns the editable schedule, selected target and the version used for its save. */
export function useScheduleEditor(schedule: Schedule | null, latest: Schedule | undefined, projectId: string, onClose: () => void) {
  const projects = useRpc("projects.list", {});
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const info = useRpc("system.info", {});
  const availability = useRpc("orchestration.availability", {});
  const create = useRpcMutation("schedules.create");
  const update = useRpcMutation("schedules.update");
  const [project, setProject] = useState(schedule?.projectId ?? projectId);
  const teams = useRpc("orchestration.list", { projectId: project, includeArchived: true }, { enabled: Boolean(project) });
  const [title, setTitle] = useState(schedule?.title ?? "");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [minutes, setMinutes] = useState(schedule?.everyMinutes ?? 1440);
  const [mode, setMode] = useState<RunMode>(schedule?.mode ?? "plan");
  const { permission, select: setPermission, error: permissionError, ready: permissionReady } = usePermissionSelection(schedule?.permissionMode);
  const [chosenWorkspace, setWorkspace] = useState<WorkspaceMode>(schedule?.workspaceMode ?? "worktree");
  const git = useScheduleGit(project, chosenWorkspace);
  const workspace = git.workspace;
  const [target, setTarget] = useState(() => scheduleTarget(schedule));
  const [localError, setLocalError] = useState<string | null>(null);
  const choice = scheduleTargetChoice(target);
  const revision = target.kind === "team" ? target.revision : null;
  const lead = revision?.members.find((member) => member.managerKey === null);
  const currentTeam = revision ? teams.data?.find((item) => item.team.id === revision.teamId) : undefined;
  const archived = currentTeam ? currentTeam.team.archivedAt !== null : target.kind === "team" && target.archived;
  const teamTarget = target.kind === "team";
  const retainedTeam = teamTarget && schedule?.executionTarget?.kind === "team" && schedule.executionTarget.teamRevisionId === target.target.teamRevisionId;
  const pending = create.isPending || update.isPending;
  const conflict = Boolean(schedule && latest && latest.version !== schedule.version);
  const { projectIssue, targetIssue } = scheduleDraftIssue(
    project,
    projects.data?.map((item) => item.id),
    target,
    archived,
    retainedTeam,
    git.teamReason,
  );
  const error = localError ?? create.error?.message ?? update.error?.message ?? permissionError;

  useEffect(() => {
    if (target.kind !== "unselected" || !models.data) return;
    const initial = defaultChoice(models.data, null);
    if (initial) setTarget(scheduleModelTarget(initial));
  }, [target.kind, models.data]);

  const chooseTeam = (selected: TeamRevision) => {
    setTarget(scheduleTeamTarget(selected));
    setLocalError(null);
  };
  const chooseModel = (selected: ModelChoice) => {
    setTarget(scheduleModelTarget(selected));
    setLocalError(null);
  };
  const changeSettings = (selected: ModelChoice) => {
    setTarget(scheduleTargetSettings(target, selected));
    if (target.kind !== "team") setLocalError(null);
  };
  const retryChecks = () => {
    void teams.refetch();
    void availability.refetch();
    void models.refetch();
    void info.refetch();
    void projects.refetch();
  };
  const pickerTeams = scheduleTeamChoices({ teams, target, teamBlocker: git.teamReason, onSelect: chooseTeam, retry: retryChecks });
  const effectiveMembers = revision?.members.map((member) => (member.managerKey === null && choice ? { ...member, settings: choice } : member)) ?? [];
  const offlineMember = effectiveMembers.find((member) => {
    const model = models.data?.find((item) => item.agent === member.settings.agent && item.id === member.settings.model);
    const agent = member.settings.agent;
    return (info.data && (!isHarnessId(agent) || !harnessLoggedIn(harnessInfo(info.data, agent)))) || (models.data && (!model || model.unavailable));
  });
  let previewReason: string | null = null;
  if (availability.isError) previewReason = "Team availability could not load. The schedule can still be saved.";
  else if (availability.data && !availability.data.enabled) previewReason = availability.data.reason ?? "Team execution is disabled in Settings.";

  const submit = () => {
    if (pending || !permissionReady || projectIssue || targetIssue || !title.trim() || !prompt.trim()) return;
    setLocalError(null);
    try {
      const base = { title: title.trim(), prompt: prompt.trim(), mode, permissionMode: permission, workspaceMode: workspace, everyMinutes: minutes, ...scheduleTargetPayload(target, project) };
      if (schedule) update.mutate({ id: schedule.id, patch: { ...base, expectedVersion: schedule.version } }, { onSuccess: onClose });
      else create.mutate({ projectId: project, ...base }, { onSuccess: onClose });
    } catch (failure) {
      setLocalError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return {
    fields: { project, title, prompt, minutes, mode, permission, workspace, worktreeBlocked: git.cannotBranch },
    target: { selection: target, choice, revision, lead, currentTeam, archived, teamTarget, retainedTeam, pickerTeams, offlineMember, previewReason },
    resources: { projects, models, info, teams, availability },
    status: { pending, conflict, projectIssue, targetIssue, error, permissionReady },
    actions: { setProject, setTitle, setPrompt, setMinutes, setMode, setPermission, setWorkspace, chooseTeam, chooseModel, changeSettings, retryChecks, submit },
  };
}
