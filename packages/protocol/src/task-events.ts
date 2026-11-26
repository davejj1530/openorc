import { z } from "zod";
import { TaskStatus } from "./domain.js";
import { AgentKind } from "./events.js";
import { Visualization } from "./visualization.js";

/** Who did something to a task: the person, an agent from its thread, or the app as the work went on. */
export const TaskActor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("agent"), agent: AgentKind, threadId: z.string().nullable() }),
  z.object({ kind: z.literal("app") }),
]);
export type TaskActor = z.infer<typeof TaskActor>;
/**
 * What an agent can put under an update on a task. A checklist is a plan or a set of notes with each item's state; a
 * pull request is named by its number alone, and the app draws what GitHub says of it; a visual is a self-contained
 * HTML fragment, drawn as the visualize tool's is.
 */
export const TaskUpdateCard = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("checklist"),
    title: z.string().trim().min(1).max(80),
    items: z
      .array(
        z.object({
          text: z.string().trim().min(1).max(200),
          done: z.boolean(),
          detail: z.string().trim().max(80).optional().describe("A few words at the item's end, such as the file and line it is about."),
        }),
      )
      .min(1)
      .max(20),
  }),
  z.object({ kind: z.literal("pull_request"), number: z.number().int().positive().describe("The pull request's number in this project's repository.") }),
  z.object({ kind: z.literal("visual"), ...Visualization.shape }),
]);
export type TaskUpdateCard = z.infer<typeof TaskUpdateCard>;
/** An agent's update on a task: where the work stands, a card when one says it better, and replies when the person should answer. */
export const TaskUpdate = z.object({
  message: z.string().trim().min(1).max(600),
  card: TaskUpdateCard.optional(),
  replies: z.array(z.string().trim().min(1).max(40)).min(1).max(3).optional(),
});
export type TaskUpdate = z.infer<typeof TaskUpdate>;
const taskEvent = { id: z.number(), taskId: z.string(), at: z.number(), actor: TaskActor };
/** One line of a task's history. Names are kept as they were then, since a column can be renamed or removed later. */
export const TaskEvent = z.discriminatedUnion("kind", [
  z.object({ ...taskEvent, kind: z.literal("created") }),
  /** It took a status, and the board column it was put in when it was put in one. `back` marks a move to a column before the one it left. */
  z.object({ ...taskEvent, kind: z.literal("moved"), status: TaskStatus, column: z.string().nullable(), columnId: z.string().nullable().optional(), back: z.boolean().optional() }),
  /** A column's job started for it: the job's name, its agent and the thread it runs in while that thread exists. */
  z.object({ ...taskEvent, kind: z.literal("started"), label: z.string(), agent: AgentKind, threadId: z.string().nullable() }),
  /**
   * An agent's update, with the reply the person pressed once they have. One the app posts, as when a card has gone
   * round too often, names the thread its replies go to.
   */
  z.object({
    ...taskEvent,
    kind: z.literal("update"),
    ...TaskUpdate.shape,
    answer: z.object({ reply: z.string(), at: z.number() }).nullable(),
    replyThreadId: z.string().nullable().optional(),
  }),
]);
export type TaskEvent = z.infer<typeof TaskEvent>;
