import { ModelExecutionSettings, normalizeModelSettings, type AgentKind, type Schedule } from "@openorc/protocol";
import type { ModelChoice } from "../components/ModelPicker";

export type ScheduleTarget = { kind: "unselected" } | { kind: "legacy"; agent: AgentKind; model: string | null; effort: string | null } | { kind: "model"; settings: ModelExecutionSettings };

/** Editing an old schedule must not replace a provider default . */
export function scheduleTarget(schedule: Schedule | null): ScheduleTarget {
  if (!schedule || schedule.retiredTeam) return { kind: "unselected" };
  if (schedule.executionTarget?.kind === "model") return { ...schedule.executionTarget, settings: normalizeModelSettings(schedule.executionTarget.settings) };
  return { kind: "legacy", ...normalizeModelSettings({ agent: schedule.agent, model: schedule.model, effort: schedule.effort }) };
}

export function scheduleTargetChoice(target: ScheduleTarget): ModelChoice | null {
  if (target.kind === "model") return target.settings;
  if (target.kind === "legacy") return target.model ? { agent: target.agent, model: target.model, effort: target.effort } : null;
  return null;
}

export function scheduleModelTarget(choice: ModelChoice): ScheduleTarget {
  return { kind: "model", settings: normalizeModelSettings(ModelExecutionSettings.parse({ ...choice, fastMode: Boolean(choice.fastMode) })) };
}

/** Report compatibility without replacing a saved model . */
export function scheduleDraftIssue(project: string, availableProjects: readonly string[] | undefined, target: ScheduleTarget) {
  let projectIssue: string | null = null;
  if (!project) projectIssue = "Choose a project.";
  else if (availableProjects && !availableProjects.includes(project)) projectIssue = "This project is unavailable. Choose an available project.";

  let targetIssue: string | null = null;
  if (target.kind === "unselected") targetIssue = "Choose a model.";
  return { projectIssue, targetIssue };
}

export function scheduleTargetPayload(target: ScheduleTarget) {
  if (target.kind === "unselected") throw new Error("Choose a model.");
  if (target.kind === "legacy") return { executionTarget: null, agent: target.agent, model: target.model, effort: target.effort };
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
