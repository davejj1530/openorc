import { z } from "zod";
import { ClaudeAccountId } from "./claude-accounts.js";
import { CommentRecipient } from "./task-comments.js";

/**
 * Refine: a read-only agent run that reads a task and its project, then hands back a suggested title, description and
 * labels. The task changes only when the person uses the suggestion.
 */
export const TaskSuggestion = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().max(200000),
    labels: z.array(z.string().trim().min(1)).default([]),
    note: z.string().trim().min(1).max(600),
  })
  .strict();
export type TaskSuggestion = z.infer<typeof TaskSuggestion>;

/** The task document a refine started from, so the person can tell when theirs has moved on since. */
export const TaskDocumentSnapshot = z.object({ title: z.string(), spec: z.string(), labels: z.array(z.string()) }).strict();
export type TaskDocumentSnapshot = z.infer<typeof TaskDocumentSnapshot>;

/** `unchanged`: the agent finished and suggested the document as it was. */
export const TaskRefineState = z.enum(["running", "ready", "unchanged", "error", "cancelled"]);
export type TaskRefineState = z.infer<typeof TaskRefineState>;

export type TaskRefine = {
  id: string;
  taskId: string;
  state: TaskRefineState;
  recipient: CommentRecipient;
  /** What the person asked for; empty for a general tidy-up. */
  instruction: string;
  base: TaskDocumentSnapshot;
  suggestion: TaskSuggestion | null;
  /** The agent's latest step while it runs, such as "Reading TaskDocumentFields.tsx". */
  step: string | null;
  error: string | null;
  runId: string | null;
  createdAt: number;
  updatedAt: number;
};

export const TaskRefineStart = z
  .object({
    taskId: z.string(),
    recipient: CommentRecipient,
    /** The Claude account a Claude model refines on; an Orcling keeps its own. */
    claudeAccountId: ClaudeAccountId.optional(),
    instruction: z.string().max(4000).default(""),
    /** Refine again: the next suggestion builds on the last one, in the same agent session when it can. */
    again: z.boolean().default(false),
    /** Refine again after editing the suggestion: the person's version, which the next suggestion starts from. */
    edited: z
      .object({ title: z.string(), description: z.string().max(200000), labels: z.array(z.string()) })
      .strict()
      .optional(),
  })
  .strict();

export function sameTaskDocument(a: TaskDocumentSnapshot, b: TaskDocumentSnapshot): boolean {
  const labels = (list: string[]) => [...new Set(list.map((label) => label.trim()).filter(Boolean))].sort().join("\n");
  return a.title.trim() === b.title.trim() && a.spec.trim() === b.spec.trim() && labels(a.labels) === labels(b.labels);
}

/** Refine's methods, kept beside its types as projects.ts keeps its own. */
export const taskRefineRpcParams = {
  /** The task's current Refine: running, or a suggestion waiting for the person. Null when there is none. */
  "tasks.refine.get": z.object({ taskId: z.string() }),
  "tasks.refine.start": TaskRefineStart,
  "tasks.refine.stop": z.object({ taskId: z.string() }),
  /** Puts the current suggestion away, whether the person used it or discarded it. */
  "tasks.refine.dismiss": z.object({ taskId: z.string() }),
};

export interface TaskRefineRpcResults {
  "tasks.refine.get": TaskRefine | null;
  "tasks.refine.start": TaskRefine;
  "tasks.refine.stop": null;
  "tasks.refine.dismiss": null;
}
