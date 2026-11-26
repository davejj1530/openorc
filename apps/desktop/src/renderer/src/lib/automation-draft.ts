import { automationProblem, type Automation, type AutomationAction, type AutomationTrigger, type BoardColumn, type BoardStage, type ReadyMadeAutomation } from "@openorc/protocol";
import { statusLabel } from "../components/status";

/** An automation as its form holds it: what it waits for and its steps, before it is saved. */
export type RuleDraft = { name: string; projectId: string; taskId: string | null; trigger: AutomationTrigger; actions: AutomationAction[] };
/** What a new automation's form starts with: a ready-made rule's contents, or the task it is kept to. */
export type RulePreset = { made?: Extract<ReadyMadeAutomation, { kind: "rule" }>; taskId?: string };

export const triggerOptions = [
  { value: "opened", label: "A pull request opens" },
  { value: "checks_failed", label: "Checks fail on a pull request" },
  { value: "merged", label: "A pull request merges" },
  { value: "task_created", label: "A task is created" },
  { value: "check", label: "Something you describe" },
] as const;
export type TriggerKey = (typeof triggerOptions)[number]["value"];

export const stepOptions = [
  { value: "agent", label: "Start an agent" },
  { value: "move", label: "Move the task" },
  { value: "task", label: "Create a task" },
] as const;

/** How often a check runs, as the form offers it. */
export const checkMinutes = [1, 5, 15, 30, 60, 360, 1440] as const;

export const triggerKey = (trigger: AutomationTrigger): TriggerKey => (trigger.kind === "pull_request" ? trigger.on : trigger.kind);

/** The trigger for a choice, keeping what the last one had of the same kind. One kept to a task reads only that task's pull request. */
export function triggerFor(key: TriggerKey, last: AutomationTrigger, taskId: string | null): AutomationTrigger {
  if (key === "task_created") return { kind: "task_created" };
  if (key === "check") return last.kind === "check" ? last : { kind: "check", what: "", command: "", everyMinutes: 5 };
  return { kind: "pull_request", on: key, scope: taskId || last.kind !== "pull_request" ? "ours" : last.scope };
}

export function stepFor(kind: AutomationAction["kind"], last: AutomationAction): AutomationAction {
  if (kind === "agent") return last.kind === "agent" ? last : { kind, prompt: "", choice: null };
  return last.kind === "agent" ? { kind, stage: kind === "move" ? "done" : "backlog", columnId: null } : { kind, stage: last.stage, columnId: last.columnId };
}

export function newDraft(projectId: string, preset: RulePreset | undefined): RuleDraft {
  const { made, taskId = null } = preset ?? {};
  if (made) return { name: made.name, projectId, taskId, trigger: made.trigger, actions: [...made.actions] };
  return { name: "", projectId, taskId, trigger: { kind: "pull_request", on: "checks_failed", scope: "ours" }, actions: [{ kind: "agent", prompt: "", choice: null }] };
}

export const draftOf = ({ name, projectId, taskId, trigger, actions }: Automation): RuleDraft => ({ name, projectId, taskId, trigger, actions });

/** Whether everything the form asks for is written. */
export function draftComplete(draft: RuleDraft): boolean {
  const { trigger } = draft;
  if (!draft.name.trim() || !draft.projectId) return false;
  if (trigger.kind === "check" && !(trigger.what.trim() && trigger.command.trim())) return false;
  return draft.actions.every((action) => action.kind !== "agent" || action.prompt.trim());
}

/** Why the draft cannot be saved as it stands, once it is complete. */
export const draftProblem = (draft: RuleDraft): string | null => (draftComplete(draft) ? automationProblem(draft) : null);

const stages: readonly BoardStage[] = ["backlog", "in_progress", "review", "done"];
export type PlaceOption = { value: string; label: string; place: { stage: BoardStage; columnId: string | null } };

/** Where a step can put a task: the board's own columns, or its four stages while the project keeps none. */
export function placeOptions(columns: readonly BoardColumn[]): PlaceOption[] {
  if (columns.length > 0) return columns.map((column) => ({ value: column.id, label: column.name, place: { stage: column.stage, columnId: column.id } }));
  return stages.map((stage) => ({ value: stage, label: statusLabel[stage], place: { stage, columnId: null } }));
}

/** The option a step's place is, the first of its stage when its column has gone. */
export function placeValue(place: { stage: BoardStage; columnId: string | null }, options: readonly PlaceOption[]): string {
  return (
    (options.find((option) => option.place.columnId === place.columnId && option.place.stage === place.stage) ?? options.find((option) => option.place.stage === place.stage) ?? options[0])?.value ??
    ""
  );
}
