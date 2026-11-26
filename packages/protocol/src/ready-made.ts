import type { BoardStage } from "./domain.js";

/** The columns a project's board starts with, until the project keeps its own. */
export const DEFAULT_BOARD_COLUMNS: readonly { name: string; stage: BoardStage }[] = [
  { name: "Backlog", stage: "backlog" },
  { name: "In progress", stage: "in_progress" },
  { name: "Review", stage: "review" },
  { name: "Done", stage: "done" },
];

/**
 * An automation the app offers ready to add. One for the board adds columns that start an agent for each card put in
 * them, before the work begins or as the work itself, with what that agent is told; one on a timer opens a new
 * schedule already filled in.
 */
export type ReadyMadeAutomation =
  | { id: string; kind: "board"; name: string; what: string; place: "before_work" | "work"; columns: readonly { name: string; prompt: string }[] }
  | { id: string; kind: "schedule"; name: string; what: string; prompt: string; everyMinutes: number };

export const READY_MADE_AUTOMATIONS: readonly ReadyMadeAutomation[] = [
  {
    id: "plan_first",
    kind: "board",
    name: "Plan first",
    what: "When a card arrives, the agent writes a plan and waits for your approval.",
    place: "before_work",
    columns: [
      {
        name: "Plan",
        prompt:
          'Before changing any code, write a plan for this task. Post it with task_report as a checklist card named Plan, one item for each step, and offer the reply "Approve the plan". Then end your turn. Carry on only after the person approves.',
      },
    ],
  },
  {
    id: "build_review",
    kind: "board",
    name: "Build, then review",
    what: "A second agent reviews the build, and sends it back until it is right.",
    place: "work",
    columns: [
      { name: "Build", prompt: "Do the work this task describes. If the task has a plan, keep it current with task_report as its steps get done." },
      {
        name: "Code review",
        prompt:
          "Review the work on this task against what the task asks for. Read the changes and run the checks that apply. Hold it to the standard the task sets, no higher. Post what you found with task_report as a checklist card named Review notes. If something is wrong or missing, move the task back to the column it came from so it gets fixed. If it does what was asked, move it on.",
      },
    ],
  },
  {
    id: "dependency_updates",
    kind: "schedule",
    name: "Dependency updates",
    what: "Every week, check for updates and open one pull request.",
    everyMinutes: 10_080,
    prompt: "Check this project's dependencies for updates and known vulnerabilities. Open one pull request with the updates that are safe to take, and list the ones that need a decision.",
  },
  {
    id: "weekly_digest",
    kind: "schedule",
    name: "Weekly digest",
    what: "Every week, what shipped and what waits on you.",
    everyMinutes: 10_080,
    prompt: "Summarize what changed in this project over the last week: what shipped, what is in progress, and what is waiting on a person.",
  },
  {
    id: "review_recent_changes",
    kind: "schedule",
    name: "Review recent changes",
    what: "Every day, look over the last day's commits for bugs.",
    everyMinutes: 1440,
    prompt: "Review the commits of the last day for bugs and risky changes. Report only what is worth fixing.",
  },
];
