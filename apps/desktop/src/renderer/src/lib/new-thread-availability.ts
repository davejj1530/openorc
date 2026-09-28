import { harnessInfo, harnessLoggedIn, harnessName, isHarnessId, normalizeModelSettings, type Project, type RpcResults, type TeamRevision } from "@openorc/protocol";
import type { ModelChoice, TeamPickerChoices } from "../components/ModelPicker";
import { teamDepth, type NewThreadTarget } from "./new-thread-draft";

interface QueryState<T> {
  data: T | undefined;
  failed: boolean;
  pending?: boolean;
}

export interface NewThreadAvailabilityInput {
  projectId: string;
  projects: Project[] | undefined;
  /** Why the project can't have worktrees or teams yet, if it can't. */
  teamBlocker: string | null;
  projectsFailed: boolean;
  permissionReady: boolean;
  target: NewThreadTarget;
  choice: ModelChoice | null;
  teams: QueryState<RpcResults["orchestration.list"]>;
  availability: QueryState<RpcResults["orchestration.availability"]>;
  models: QueryState<RpcResults["agents.models"]>;
  system: QueryState<RpcResults["system.info"]>;
}

export interface NewThreadAvailability {
  selectedProject: Project | undefined;
  selectedTeam: RpcResults["orchestration.list"][number] | undefined;
  targetIssue: string | null;
  projectIssue: string | null;
  disabledReason: string | null;
  teamOptions: TeamPickerChoices["options"];
  teamStatus: string | null;
}

/** The same provider checks govern the selected revision and every team in the picker. */
export function evaluateNewThreadAvailability(input: NewThreadAvailabilityInput): NewThreadAvailability {
  const { target, choice, teams, availability, models, system } = input;
  const revision = target.kind === "team" ? target.revision : null;
  const selectedTeam = revision ? teams.data?.find((detail) => detail.team.id === revision.teamId) : undefined;
  const selectedProject = input.projects?.find((project) => project.id === input.projectId);
  let gateReason: string | null = null;
  if (availability.failed) gateReason = "Team availability could not load. Retry to continue.";
  else if (!availability.data) gateReason = "Checking team availability…";
  else if (!availability.data.enabled) gateReason = availability.data.reason ?? "Enable team execution in Settings to start a team.";
  else gateReason = input.teamBlocker;

  const providerIssue = (settings: ModelChoice, memberName?: string): string | null => {
    const prefix = memberName ? `${memberName}: ` : "";
    if (models.failed || system.failed) return "Provider availability could not load. Retry to continue.";
    if (!models.data || !system.data) return memberName ? "Checking team providers…" : "Checking provider availability…";
    if (!isHarnessId(settings.agent) || !harnessLoggedIn(harnessInfo(system.data, settings.agent)))
      return `${prefix}${memberName ? "sign" : "Sign"} in to ${harnessName(settings.agent)} before starting.`;
    const model = models.data.find((option) => option.agent === settings.agent && option.id === settings.model);
    if (!model || model.unavailable)
      return memberName
        ? `${prefix}${model?.unavailable ?? "the saved model is unavailable"}. Choose another team or update it in Orchestration.`
        : `${model?.unavailable ?? "The selected model is unavailable"}. Choose another model.`;
    if (settings.effort && !model.efforts.includes(settings.effort))
      return memberName ? `${prefix}the saved effort is unavailable for this model.` : "The selected effort is unavailable for this model.";
    if (settings.fastMode && !model.fastMode?.supported)
      return memberName ? `${prefix}${model.fastMode?.reason ?? "Fast mode is unavailable for this model."}` : (model.fastMode?.reason ?? "Fast mode is unavailable for this model.");
    return null;
  };

  const capabilityIssue = (teamRevision: TeamRevision, effectiveLead = false): string | null => {
    if (gateReason) return gateReason;
    if (teamDepth(teamRevision) > availability.data!.maxHierarchyDepth) return `Teams support up to ${availability.data!.maxHierarchyDepth} levels. Choose a team within that limit.`;
    for (const member of teamRevision.members) {
      const settings = normalizeModelSettings(effectiveLead && member.managerKey === null && choice ? choice : member.settings);
      const issue = providerIssue(settings, member.name);
      if (issue) return issue;
    }
    return null;
  };

  let teamIssue: string | null = null;
  if (revision) {
    if (teams.failed) teamIssue = "Saved teams could not load. Retry to continue.";
    else if (!teams.data) teamIssue = "Loading the selected team…";
    else if (!selectedTeam) teamIssue = "This team is no longer available in this project. Choose a team or model to continue.";
    else if (selectedTeam.team.archivedAt !== null) teamIssue = "This team is archived. Restore it in Orchestration or choose another target.";
    else teamIssue = capabilityIssue(revision, true);
  }
  let targetIssue: string | null = null;
  if (target.kind === "unavailable") targetIssue = target.reason;
  else if (target.kind === "team") targetIssue = teamIssue;
  else if (choice) targetIssue = providerIssue(choice);

  let projectIssue: string | null = null;
  if (input.projectsFailed) projectIssue = "Projects could not load. Retry to continue.";
  else if (input.projects && !selectedProject) projectIssue = "This project is unavailable. Choose a project to continue.";
  else if (!selectedProject) projectIssue = "Loading projects…";
  let disabledReason = projectIssue;
  if (!disabledReason && !input.permissionReady) disabledReason = "Loading saved permissions…";
  if (!disabledReason) disabledReason = targetIssue;
  if (!disabledReason && !choice) disabledReason = "Log in to Codex or Claude Code first";

  let teamStatus = gateReason;
  if (teams.failed) teamStatus = "Saved teams could not load.";
  else if (teams.pending) teamStatus = "Loading teams…";

  return {
    selectedProject,
    selectedTeam,
    targetIssue,
    projectIssue,
    disabledReason,
    teamOptions: (teams.data ?? [])
      .filter((team) => team.team.archivedAt === null)
      .map((team) => ({
        teamId: team.team.id,
        revisionId: team.revision.id,
        name: team.revision.name,
        revision: team.revision.number,
        memberCount: team.revision.members.length,
        disabledReason: capabilityIssue(team.revision),
      })),
    teamStatus,
  };
}
