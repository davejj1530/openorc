import { createContext, useContext, useRef, type ReactNode } from "react";
import { createTaskDraftBarrier, taskDraftPatch } from "./task-draft";
import { core } from "./rpc";
import { invalidateTags } from "./query";

type TaskDraftActions = ReturnType<typeof createTaskDraftBarrier>;
const TaskDraftContext = createContext<TaskDraftActions | null>(null);

/** Scoped to TaskView; panels and Activity share the Overview save barrier. */
export function TaskDraftProvider({ taskId, children }: { taskId: string; children: ReactNode }) {
  const actions = useRef<TaskDraftActions | null>(null);
  if (!actions.current)
    actions.current = createTaskDraftBarrier(taskId, async (draft) => {
      await core.call("tasks.update", { id: taskId, patch: taskDraftPatch(draft) });
      invalidateTags(["tasks", "inbox", "threads", `task:${taskId}`]);
    });
  return <TaskDraftContext.Provider value={actions.current}>{children}</TaskDraftContext.Provider>;
}

export function useTaskDraftActions(): TaskDraftActions {
  const actions = useContext(TaskDraftContext);
  if (!actions) throw new Error("Task draft actions require a task workspace.");
  return actions;
}
