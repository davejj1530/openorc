import { z } from "zod";
import type { AgentEvent } from "@openorc/protocol";

export const cursorTodos = z.object({
  toolCallId: z.string(),
  merge: z.boolean(),
  todos: z.array(z.object({ id: z.string(), content: z.string(), status: z.enum(["pending", "in_progress", "completed", "cancelled"]) })),
});
type Todo = z.infer<typeof cursorTodos>["todos"][number];

/** Cursor can update just part of its checklist; keep the unchanged entries visible. */
export class CursorTodos {
  private readonly entries = new Map<string, Todo>();
  constructor(private readonly runId: string) {}

  update(params: z.infer<typeof cursorTodos>): AgentEvent {
    if (!params.merge) this.entries.clear();
    for (const todo of params.todos) this.entries.set(todo.id, todo);
    const todos = [...this.entries.values()];
    const marks = { pending: "☐", in_progress: "◐", completed: "☑", cancelled: "−" };
    return {
      type: "activity.updated",
      runId: this.runId,
      ts: Date.now(),
      activityId: "cursor-todos",
      label: "Plan",
      status: todos.every((todo) => todo.status === "completed" || todo.status === "cancelled") ? "success" : "running",
      text: todos.map((todo) => `${marks[todo.status]} ${todo.content}`).join("\n"),
    };
  }
}
