import type { ModelChoice, NewThreadTarget } from "@openorc/client";
import { harnessInfo, harnessLoggedIn, harnessName, isHarnessId, type Project, type RpcResults } from "@openorc/protocol";
interface QueryState<T> {
  data: T | undefined;
  failed: boolean;
}
export interface NewThreadAvailabilityInput {
  projectId: string;
  projects: Project[] | undefined;
  projectsFailed: boolean;
  permissionReady: boolean;
  target: NewThreadTarget;
  choice: ModelChoice | null;
  models: QueryState<RpcResults["agents.models"]>;
  system: QueryState<RpcResults["system.info"]>;
}
export function evaluateNewThreadAvailability(input: NewThreadAvailabilityInput) {
  const { target, choice, models, system } = input;
  const selectedProject = input.projects?.find((project) => project.id === input.projectId);
  const providerIssue = (settings: ModelChoice): string | null => {
    if (models.failed || system.failed) return "Provider availability could not load. Retry to continue.";
    if (!models.data || !system.data) return "Checking provider availability…";
    if (!isHarnessId(settings.agent) || !harnessLoggedIn(harnessInfo(system.data, settings.agent))) return `Sign in to ${harnessName(settings.agent)} before starting.`;
    const model = models.data.find((option) => option.agent === settings.agent && option.id === settings.model);
    if (!model || model.unavailable) return `${model?.unavailable ?? "The selected model is unavailable"}. Choose another model.`;
    if (settings.effort && !model.efforts.includes(settings.effort)) return "The selected effort is unavailable for this model.";
    if (settings.fastMode && !model.fastMode?.supported) return model.fastMode?.reason ?? "Fast mode is unavailable for this model.";
    return null;
  };
  let targetIssue: string | null = null;
  if (target.kind === "unavailable") targetIssue = target.reason;
  else if (choice) targetIssue = providerIssue(choice);
  let projectIssue: string | null = null;
  if (input.projectsFailed) projectIssue = "Projects could not load. Retry to continue.";
  else if (input.projects && !selectedProject) projectIssue = "This project is unavailable. Choose a project to continue.";
  else if (!selectedProject) projectIssue = "Loading projects…";
  const disabledReason = projectIssue ?? (!input.permissionReady ? "Loading saved permissions…" : null) ?? targetIssue ?? (!choice ? "Log in to Codex or Claude Code first" : null);
  return { selectedProject, targetIssue, projectIssue, disabledReason };
}
