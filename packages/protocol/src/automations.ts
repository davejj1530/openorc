import { z } from "zod";
import { BoardStage, ThreadChoice } from "./domain.js";
import { AgentKind } from "./events.js";

/** How often a check of the person's or an agent's own may run, in minutes: from every minute to once a week. */
export const AUTOMATION_CHECK_MINUTES = { min: 1, max: 10_080 } as const;

/**
 * What sets an automation off.
 *
 * A pull request is one on the project's GitHub repository; `ours` keeps to those this app's own threads opened, which
 * have a task or a thread to act on.
 *
 * A check is a command written for the project and run in its folder on a timer. Each line it prints is one thing that
 * happened, acted on once: a line with a tab is told apart by what comes before the tab and described by what comes
 * after it. `what` says in plain words what the command looks for, for the person who turns it on.
 *
 * A program is one an agent wrote for the automation, from what the person wants watched, kept in a folder of its own
 * on this computer by its `id`. It runs for as long as the automation is on, however its source needs (a live
 * connection, watching files, a timer), and prints a line of JSON for each thing that happens.
 */
const PullTrigger = z.object({ kind: z.literal("pull_request"), on: z.enum(["opened", "checks_failed", "merged"]), scope: z.enum(["ours", "any"]) });
const TaskCreatedTrigger = z.object({ kind: z.literal("task_created") });
const CheckTrigger = z.object({
  kind: z.literal("check"),
  what: z.string().trim().min(1).max(200),
  command: z.string().trim().min(1).max(4000),
  everyMinutes: z.number().int().min(AUTOMATION_CHECK_MINUTES.min).max(AUTOMATION_CHECK_MINUTES.max),
});
const ProgramTrigger = z.object({ kind: z.literal("program"), id: z.uuid(), what: z.string().trim().min(1).max(200) });
export const AutomationTrigger = z.discriminatedUnion("kind", [PullTrigger, TaskCreatedTrigger, CheckTrigger, ProgramTrigger]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;
/** What an agent writing an automation in its thread may set it off with: anything but a program, which is written in a thread of its own. */
export const ProposedTrigger = z.discriminatedUnion("kind", [PullTrigger, TaskCreatedTrigger, CheckTrigger]);

/** The name of a value a trigger program reads from its environment, such as a token. */
export const TRIGGER_VALUE_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/**
 * A trigger program's own account of itself, in trigger.json in its folder, written by its agent and changed by the
 * person as they like: the command that starts it there, and the values the person adds for it, each with where to get it.
 */
export const TriggerManifest = z.object({
  run: z.string().trim().min(1).max(1000),
  env: z
    .array(z.object({ name: z.string().regex(TRIGGER_VALUE_NAME), about: z.string().trim().max(300).default("") }))
    .max(20)
    .default([]),
});
export type TriggerManifest = z.infer<typeof TriggerManifest>;

/**
 * A trigger program as the person sees it: the command that starts it once its agent has written it, the values it
 * needs and whether each is added, the thread its agent writes it in, and how it runs: listening for its automation,
 * being tried, stopped with why, or off. `recent` is what it printed lately, newest last: an event by its title, else
 * its own words.
 */
export type TriggerState = {
  id: string;
  run: string | null;
  env: { name: string; about: string; added: boolean }[];
  threadId: string | null;
  state: "listening" | "trying" | "stopped" | "off";
  problem: string | null;
  recent: { at: number; text: string; event: boolean }[];
};

/** Where a task is put: a stage, and the board's own column when the project keeps columns. */
const Place = { stage: BoardStage, columnId: z.string().nullable() };

/**
 * One thing an automation does, in the order its steps are listed. An agent works on the task of what happened when
 * there is one, in a thread of its own under the automation's name; with no task it starts a thread in the project. A
 * task made by one step is the task of the steps after it.
 */
export const AutomationAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), prompt: z.string().trim().min(1).max(8000), choice: ThreadChoice.nullable() }),
  z.object({ kind: z.literal("move"), ...Place }),
  z.object({ kind: z.literal("task"), ...Place }),
]);
export type AutomationAction = z.infer<typeof AutomationAction>;

export const AutomationActions = z.array(AutomationAction).min(1).max(4);

/** A rule of a project: when something happens, do these steps. */
export const Automation = z.object({
  id: z.string(),
  projectId: z.string(),
  /** The one task it is kept to, for one added on a task. */
  taskId: z.string().nullable(),
  name: z.string(),
  trigger: AutomationTrigger,
  actions: AutomationActions,
  enabled: z.boolean(),
  /** One an agent wrote, which stays off until the person turns it on or dismisses it. */
  proposed: z.boolean(),
  /** The agent that wrote it and the thread it wrote it in, while that thread is there. */
  madeBy: z.object({ agent: AgentKind, threadId: z.string().nullable(), threadTitle: z.string().nullable() }).nullable(),
  /** When it last acted on something. */
  lastFiredAt: z.number().nullable(),
  /** Why its last look or its last steps did not work, until they do. */
  problem: z.string().nullable(),
  createdAt: z.number(),
});
export type Automation = z.infer<typeof Automation>;

/** An automation as it is written, by a person in the form or by an agent. */
export const AutomationDraft = z.object({
  projectId: z.string(),
  taskId: z.string().nullable().optional(),
  name: z.string().trim().min(1).max(80),
  trigger: AutomationTrigger,
  actions: AutomationActions,
});
export type AutomationDraft = z.infer<typeof AutomationDraft>;

/** Whether what a trigger reports can have a task: a check has none unless its automation is kept to one. */
export const triggerHasTask = (trigger: AutomationTrigger, taskId: string | null | undefined): boolean =>
  trigger.kind === "task_created" || Boolean(taskId) || (trigger.kind === "pull_request" && trigger.scope === "ours");

/**
 * Why a draft cannot be saved, or null when it can. A card can be moved only where there is a task to move, and an
 * automation that makes a task for every new task would never stop.
 */
export function automationProblem(draft: Pick<AutomationDraft, "trigger" | "actions" | "taskId">): string | null {
  if (draft.taskId && draft.trigger.kind === "task_created") return "An automation on one task cannot wait for a task to be created.";
  let task = triggerHasTask(draft.trigger, draft.taskId);
  for (const action of draft.actions) {
    if (action.kind === "task" && draft.trigger.kind === "task_created") return "An automation that starts when a task is created cannot create a task.";
    if (action.kind === "move" && !task) return "Nothing to move: add a step that creates a task first, or choose a trigger that has one.";
    if (action.kind === "task") task = true;
  }
  return null;
}

/** Where an agent says a task goes: a board column by its name, which sets the status with it, or a status. */
const NamedPlace = {
  column: z.string().trim().min(1).max(40).optional().describe("A column of this project's board, by its name"),
  status: BoardStage.optional().describe("A status, when no column is named"),
};

/** An automation as an agent writes it: places by a column's name, and the model left to the person. */
export const AutomationProposal = z.object({
  name: z.string().trim().min(1).max(80).describe("A short name the person will know it by"),
  when: ProposedTrigger.describe("What sets it off"),
  do: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("agent"), prompt: z.string().trim().min(1).max(8000).describe("What the agent is told to do. It is also told what happened.") }),
        z.object({ kind: z.literal("move"), ...NamedPlace }),
        z.object({ kind: z.literal("task"), ...NamedPlace }),
      ]),
    )
    .min(1)
    .max(4)
    .describe("The steps, in order"),
  taskId: z.string().optional().describe("Keeps it to one task: only that task's pull request sets it off, and a check's steps work on that task"),
});
export type AutomationProposal = z.infer<typeof AutomationProposal>;

/** What a check found when it ran once: each thing it printed, in words, or why it did not run. */
export type CheckTry = { state: "ran"; found: string[] } | { state: "failed"; reason: string };

export const automationRpcParams = {
  /** The automations of one project, or of all. */
  "automations.list": z.object({ projectId: z.string().optional() }),
  /** A new automation, or a kept one rewritten when the draft comes with its id. A new one starts switched on. */
  "automations.save": AutomationDraft.extend({ id: z.string().optional() }),
  /** On or off. Turning on one an agent wrote accepts it. One switched on acts on what happens from then. */
  "automations.switch": z.object({ id: z.string(), enabled: z.boolean() }),
  "automations.remove": z.object({ id: z.string() }),
  /** A check's command runs once in the project's folder, to see what it finds now. */
  "automations.tryCheck": z.object({ projectId: z.string(), command: z.string().trim().min(1).max(4000) }),
  /**
   * A thread where an agent on the model chosen writes a trigger program from what the person wants watched: in a new
   * folder, or in the program's own when `id` names one, to write it again.
   */
  "automations.writeTrigger": z.object({ id: z.uuid().optional(), projectId: z.string(), what: z.string().trim().min(1).max(200), choice: ThreadChoice }),
  "automations.trigger": z.object({ id: z.uuid() }),
  /** A value the trigger program reads from its environment, kept protected on this computer; an empty one is removed. */
  "automations.setTriggerValue": z.object({ id: z.uuid(), name: z.string().regex(TRIGGER_VALUE_NAME), value: z.string().max(4000) }),
  /** Runs the program to see what it prints, acting on none of it, until it is stopped or a few minutes pass. */
  "automations.tryTrigger": z.object({ id: z.uuid(), on: z.boolean() }),
};

export interface AutomationRpcResults {
  "automations.list": Automation[];
  "automations.save": Automation;
  "automations.switch": null;
  "automations.remove": null;
  "automations.tryCheck": CheckTry;
  "automations.writeTrigger": { id: string; threadId: string };
  "automations.trigger": TriggerState;
  "automations.setTriggerValue": null;
  "automations.tryTrigger": null;
}
