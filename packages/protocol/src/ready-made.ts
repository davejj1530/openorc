import type { BoardStage, TaskButton } from "./domain.js";

/** The columns a project's board starts with, until the project keeps its own. */
export const DEFAULT_BOARD_COLUMNS: readonly { name: string; stage: BoardStage }[] = [
  { name: "Backlog", stage: "backlog" },
  { name: "In progress", stage: "in_progress" },
  { name: "Review", stage: "review" },
  { name: "Done", stage: "done" },
];

/**
 * An automation the app offers ready to add. One for the board adds columns that start a job for each card put in
 * them, before the work begins or as the work itself; one on a timer opens a new schedule already filled in.
 */
export type ReadyMadeAutomation =
  | { id: string; kind: "board"; name: string; what: string; place: "before_work" | "work"; columns: readonly { name: string; button: TaskButton }[] }
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
        button: {
          id: "ready-plan",
          label: "Plan",
          runsIn: "task",
          mode: "thread",
          prompt:
            'Before changing any code, write a plan for this task. Post it with task_report as a checklist card named Plan, one item for each step, and offer the reply "Approve the plan". Then end your turn. Carry on only after the person approves.',
        },
      },
    ],
  },
  {
    id: "build_review",
    kind: "board",
    name: "Build, then review",
    what: "A second agent reviews the build and they settle the notes together.",
    place: "work",
    columns: [
      {
        name: "Build",
        button: {
          id: "ready-build",
          label: "Build",
          runsIn: "task",
          mode: "thread",
          prompt: "Do the work this task describes. If the task has a plan, keep it current with task_report as its steps get done.",
        },
      },
      {
        name: "Code review",
        button: {
          id: "ready-review",
          label: "Code review",
          runsIn: "new",
          mode: "thread",
          prompt:
            "Review the work on this task against what the task asks for. Read the changes and run the checks that apply. Send each problem to the builder's thread with thread_send and settle it there before you finish. Then post what you found with task_report as a checklist card named Review notes.",
        },
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
