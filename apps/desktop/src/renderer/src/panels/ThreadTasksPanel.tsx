import { Plus } from "../components/icons";
import type { Project, Thread } from "@openorc/protocol";
import { TaskCard } from "../components/TaskCard";
import { Button, Empty } from "../components/ui";
import { useRpc } from "../lib/query";
import { useUi } from "../lib/ui";

/** The tasks this thread delegated, live, plus a way to add one by hand. */
export function ThreadTasksPanel({ thread, project }: { thread: Thread; project: Project }) {
  const tasks = useRpc("tasks.list", { threadId: thread.id });
  const own = (tasks.data ?? []).filter((x) => x.status !== "archived");
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-line text-base">
        <span className="font-medium">Tasks</span>
        <span className="text-ink-3 tabular">{own.length}</span>
        <span className="flex-1" />
        <Button size="sm" onClick={() => useUi.getState().openNewTask(project.id, thread.id)}>
          <Plus size={12} /> Add
        </Button>
      </div>
      {own.length === 0 && !tasks.isLoading ? (
        <Empty title="No tasks yet">The agent saves a task when it finds work for later. You can add one too.</Empty>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto p-3 grid gap-2 content-start">
          {own.map((x) => (
            <TaskCard key={x.id} taskId={x.id} compact />
          ))}
        </div>
      )}
    </div>
  );
}
