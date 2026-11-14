import type { ReactNode } from "react";
import type { TaskStatus } from "@openorc/protocol";
import { Plus, X } from "../components/icons";
import { ScopedTitle } from "../components/ScopedTitle";
import { TopBar } from "../components/TopBar";
import { statusLabel } from "../components/status";
import { TaskRows } from "../components/task-list/TaskRows";
import { TaskFilterMenu } from "../components/task-list/TaskFilterMenu";
import { Button, Empty } from "../components/ui";
import { ALL_WORKSPACES, focusedProject, useLayout } from "../lib/layout";
import { useSpaceProjects } from "../lib/space-queries";
import { useTaskListSource } from "../lib/task-list-source";
import { useTaskOnlineScope } from "../lib/task-online-query";
import { useTaskListFilters, type TaskShelf } from "../lib/task-list-state";
import type { TaskRecord } from "../lib/task-records";
import "./pages.css";

function taskListBody(input: {
  error: Error | null;
  loading: boolean;
  list: TaskRecord[];
  shelf: TaskShelf;
  stage: TaskStatus | null;
  showProject: boolean;
  memoryKey: string | null;
  retry: () => void;
}): ReactNode {
  if (input.error)
    return (
      <Empty title="Tasks couldn’t load">
        <Button onClick={input.retry}>Try again</Button>
      </Empty>
    );
  if (input.loading) return <div className="document-skeleton" aria-label="Loading tasks" />;
  if (input.list.length > 0) return <TaskRows key={input.memoryKey ?? "local"} tasks={input.list} showProject={input.showProject} memoryKey={input.memoryKey} />;
  if (input.stage) return <Empty title={`No ${statusLabel[input.stage].toLowerCase()} tasks`} />;
  return <Empty title={input.shelf === "active" ? "No tasks yet" : `No ${input.shelf} tasks`} />;
}

export function TaskListView({ onNewTask }: { onNewTask: () => void }) {
  const projectId = useLayout(focusedProject);
  const { scope } = useTaskOnlineScope();
  const filters = useTaskListFilters(scope);
  const tasks = useTaskListSource(projectId, filters.assigned, filters.shelf);
  const projects = useSpaceProjects();
  const { shelf, stage } = filters;
  const all = tasks.data;
  const list = all.filter(({ task }) => (shelf === "active" ? task.status !== "done" && task.status !== "archived" : task.status === shelf) && (!stage || task.status === stage));
  return (
    <>
      <TopBar
        actions={
          <>
            {scope && filters.assigned ? (
              <Button size="sm" onClick={() => filters.patch({ assigned: false })}>
                Assigned to me <X size={12} />
              </Button>
            ) : null}
            <TaskFilterMenu
              tasks={all}
              shelf={shelf}
              stage={stage}
              onShelf={(value) => filters.patch({ shelf: value, stage: null })}
              onStage={(value) => filters.patch({ stage: value })}
              assignment={scope ? { value: filters.assigned, onChange: (value) => filters.patch({ assigned: value }) } : undefined}
              project={scope ? { id: projectId, projects: projects.data ?? [], onChange: (id) => useLayout.getState().setWorkspace(id ?? ALL_WORKSPACES) } : undefined}
            />
            <Button variant="primary" size="lg" className="ml-1 pl-2.5" onClick={onNewTask}>
              <Plus size={14} />
              New task
            </Button>
          </>
        }
      >
        <ScopedTitle>Tasks</ScopedTitle>
      </TopBar>
      <div className="page-column list-page">
        {taskListBody({ error: tasks.error, loading: tasks.isLoading, list, shelf, stage, showProject: !projectId, memoryKey: filters.key, retry: () => void tasks.refetch() })}
      </div>
    </>
  );
}
