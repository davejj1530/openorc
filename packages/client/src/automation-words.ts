import { harnessShortName, type Automation, type AutomationAction, type AutomationTrigger, type BoardColumn, type BoardStage } from "@openorc/protocol";

const STAGE: Record<BoardStage, string> = { backlog: "Backlog", in_progress: "In progress", review: "Review", done: "Done" };
type PullTrigger = Extract<AutomationTrigger, { kind: "pull_request" }>;
/** A pull request trigger in words, for any pull request and for the ones the app's own threads opened. */
const PULL: Record<PullTrigger["on"], Record<PullTrigger["scope"], string>> = {
  opened: { any: "When a pull request opens", ours: "When one of your threads opens a pull request" },
  checks_failed: { any: "When checks fail on a pull request", ours: "When checks fail on a pull request from your threads" },
  merged: { any: "When a pull request merges", ours: "When a pull request from your threads merges" },
};

export const everyWords = (minutes: number): string => {
  if (minutes === 1) return "every minute";
  if (minutes < 60) return `every ${minutes} minutes`;
  if (minutes === 60) return "every hour";
  if (minutes % 1440 === 0) return minutes === 1440 ? "every day" : `every ${minutes / 1440} days`;
  return minutes % 60 === 0 ? `every ${minutes / 60} hours` : `every ${minutes} minutes`;
};

/** The same, read on one task, whose own pull request it is. */
const ITS: Record<PullTrigger["on"], string> = { opened: "When its pull request opens", checks_failed: "When checks fail on its pull request", merged: "When its pull request merges" };

/**
 * What an automation waits for, as a sentence that starts with When. A check is told in the words its writer gave it.
 * `onTask` is for where it is read on one task.
 */
export function triggerWords(trigger: AutomationTrigger, onTask = false): string {
  if (trigger.kind === "task_created") return "When a task is created";
  if (trigger.kind === "check" || trigger.kind === "program") return `When: ${trigger.what}`;
  return onTask ? ITS[trigger.on] : PULL[trigger.on][trigger.scope];
}

/** Where a step puts a task, by the board's own name for it while the column is there. */
export function placeWords(place: { stage: BoardStage; columnId: string | null }, columns: readonly Pick<BoardColumn, "id" | "name">[]): string {
  return columns.find((column) => column.id === place.columnId)?.name ?? STAGE[place.stage];
}

export function actionWords(action: AutomationAction, columns: readonly Pick<BoardColumn, "id" | "name">[]): string {
  if (action.kind === "move") return `Move the task to ${placeWords(action, columns)}`;
  if (action.kind === "task") return `Create a task in ${placeWords(action, columns)}`;
  return action.choice ? `Start ${harnessShortName(action.choice.agent)}` : "Start an agent";
}

/** An automation's steps as one line, in order. */
export function stepsWords(automation: Pick<Automation, "actions">, columns: readonly Pick<BoardColumn, "id" | "name">[]): string {
  return automation.actions
    .map((action, index) => {
      const words = actionWords(action, columns);
      return index === 0 ? words : words.charAt(0).toLowerCase() + words.slice(1);
    })
    .join(", then ");
}
