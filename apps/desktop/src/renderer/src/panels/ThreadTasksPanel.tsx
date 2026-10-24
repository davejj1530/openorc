import { Plus } from "../components/icons";
import type { Project, Thread } from "@openorc/protocol";
import { PanelBar, PanelBarMeta } from "../components/PanelBar";
import { TaskCard } from "../components/TaskCard";
import { Button, Empty } from "../components/ui";
import { useRpc } from "../lib/client";
import { useUi } from "../lib/ui";

/** The tasks this thread delegated, live, plus a way to add one by hand. */
export function ThreadTasksPanel({ thread, project }: { thread: Thread; project: Project }) {
  const tasks = useRpc("tasks.list", { threadId: thread.id });
  const own = (tasks.data ?? []).filter((x) => x.status !== "archived");
  return (
    <div className="h-full flex flex-col min-h-0">
      <PanelBar title="Tasks" meta={<PanelBarMeta>{own.length}</PanelBarMeta>}>
        <Button onClick={() => useUi.getState().openNewTask(project.id, thread.id)}>
          <Plus size={14} /> Add
        </Button>
      </PanelBar>
      {own.length === 0 && !tasks.isLoading ? (
        <Empty title="No tasks yet">Ask the agent to save one, or add one yourself.</Empty>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-2.5 grid gap-0.5 content-start">
          {own.map((x) => (
            <TaskCard key={x.id} taskId={x.id} compact />
          ))}
        </div>
      )}
    </div>
  );
}
