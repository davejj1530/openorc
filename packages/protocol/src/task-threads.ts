import { z } from "zod";
import { ThreadChoice, type TaskThreadLink, type Thread } from "./domain.js";

export const taskThreadRpcParams = {
  /** Every thread the task has had: its current one first, then earlier work and the threads its buttons started. */
  "tasks.threads": z.object({ taskId: z.string() }),
  /** A fresh working thread seeded with the task and a brief of the last one, on its model and account unless chosen. */
  "tasks.newThread": z.object({ taskId: z.string(), choice: ThreadChoice.optional() }),
  "tasks.runButton": z.object({ taskId: z.string(), buttonId: z.string() }),
};

export interface TaskThreadRpcResults {
  "tasks.threads": TaskThreadLink[];
  "tasks.newThread": Thread;
  /** For a button set not to send: `message` is what it added to the thread's message box, and `draft` the box's whole saved draft with it. */
  "tasks.runButton": { threadId: string } | { threadId: string; message: string; draft: string };
}
