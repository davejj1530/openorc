import { defaultChoice, newThreadChoice, type ModelChoice, type NewThreadTarget } from "@openorc/client";
import { harnessInfo, harnessLoggedIn, harnessName, isHarnessId, isHostedAgent, type HarnessId, type ModelOption, type Project, type RpcResults } from "@openorc/protocol";
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
  hosted?: boolean;
}

/** What holds a new thread back: something still being read (`waiting`), or a problem the person acts on. */
export interface NewThreadIssue {
  words: string;
  waiting?: boolean;
}

export function initialThreadChoice(models: ModelOption[], preferred: HarnessId | null, system: RpcResults["system.info"] | undefined, hosted: boolean) {
  if (hosted)
    return defaultChoice(
      models.filter((model) => isHostedAgent(model.agent)),
      preferred,
    );
  return system ? newThreadChoice(models, { preferred, harnesses: system.harnesses }) : null;
}
export function evaluateNewThreadAvailability(input: NewThreadAvailabilityInput) {
  const { target, choice, models, system } = input;
  const selectedProject = input.projects?.find((project) => project.id === input.projectId);
  const providerIssue = (settings: ModelChoice): NewThreadIssue | null => {
    if (models.failed || system.failed) return { words: "Provider availability could not load. Retry to continue." };
    if (!models.data || !system.data) return { words: "Checking provider availability…", waiting: true };
    if (!isHarnessId(settings.agent) || !harnessLoggedIn(harnessInfo(system.data, settings.agent))) return { words: `Sign in to ${harnessName(settings.agent)} before starting.` };
    const model = models.data.find((option) => option.agent === settings.agent && option.id === settings.model);
    if (!model || model.unavailable) return { words: `${model?.unavailable ?? "The selected model is unavailable"}. Choose another model.` };
    if (settings.effort && !model.efforts.includes(settings.effort)) return { words: "The selected effort is unavailable for this model." };
    if (settings.fastMode && !model.fastMode?.supported) return { words: model.fastMode?.reason ?? "Fast mode is unavailable for this model." };
    return null;
  };
  let targetIssue: NewThreadIssue | null = null;
  if (target.kind === "unavailable") targetIssue = { words: target.reason };
  else if (choice && !input.hosted) targetIssue = providerIssue(choice);
  let projectIssue: NewThreadIssue | null = null;
  if (input.projectsFailed) projectIssue = { words: "Projects could not load. Retry to continue." };
  else if (input.projects && !selectedProject) projectIssue = { words: "This project is unavailable. Choose a project to continue." };
  else if (!selectedProject) projectIssue = { words: "Loading projects…", waiting: true };
  const disabledReason =
    projectIssue?.words ?? (!input.permissionReady ? "Loading saved permissions…" : null) ?? targetIssue?.words ?? (!choice ? "Enable and sign in to an agent in Settings → Connections." : null);
  return { selectedProject, issue: targetIssue ?? projectIssue, disabledReason };
}
