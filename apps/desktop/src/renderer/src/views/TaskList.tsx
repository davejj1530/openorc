import type { ReactNode } from "react";
import type { TaskStatus } from "@openorc/protocol";
import { Plus, X } from "../components/icons";
import { ScopedTitle } from "../components/ScopedTitle";
import { TopBar } from "../components/TopBar";
import { statusLabel } from "../components/status";
import { Segmented } from "../components/Segmented";
import { TaskBoard } from "../components/task-board/TaskBoard";
import { TaskRows } from "../components/task-list/TaskRows";
import { TaskFilterMenu } from "../components/task-list/TaskFilterMenu";
import { Button, Empty } from "../components/ui";
import { ALL_WORKSPACES, focusedProject, useLayout, type TasksView } from "../lib/layout";
import { useSpaceProjects } from "../lib/space-queries";
import { useTaskListSource } from "../lib/task-list-source";
import { useTaskOnlineScope } from "../lib/task-online-query";
import { useTaskListFilters, type TaskShelf } from "../lib/task-list-state";
import type { TaskRecord } from "../lib/task-records";
import { TaskContentGate } from "../components/task-online/TaskContentGate";
import "./pages.css";

const views: readonly { value: TasksView; label: string }[] = [
  { value: "list", label: "List" },
  { value: "board", label: "Board" },
];

function taskListBody(input: {
  error: Error | null;
  loading: boolean;
  /** The board's tasks, when the board is the view: every status but archived, each in its column. */
  board: TaskRecord[] | null;
  list: TaskRecord[];
  shelf: TaskShelf;
  stage: TaskStatus | null;
  showProject: boolean;
  /** The one project in scope, or null on every project. */
  projectId: string | null;
  memoryKey: string | null;
  rowKey: string | null;
  retry: () => void;
}): ReactNode {
  if (input.error)
    return (
      <Empty title="Tasks couldn’t load">
        <Button onClick={input.retry}>Try again</Button>
      </Empty>
    );
  if (input.loading) return <div className="document-skeleton" aria-label="Loading tasks" />;
  if (input.board) return <TaskBoard tasks={input.board} projectId={input.projectId} />;
  if (input.list.length > 0) return <TaskRows key={input.rowKey ?? "local"} tasks={input.list} showProject={input.showProject} memoryKey={input.memoryKey} />;
  if (input.stage) return <Empty title={`No ${statusLabel[input.stage].toLowerCase()} tasks`} />;
  return <Empty title={input.shelf === "active" ? "No tasks yet" : `No ${input.shelf} tasks`} />;
}

export function TaskListView({ onNewTask }: { onNewTask: () => void }) {
  return (
    <TaskContentGate>
      <TaskListContent onNewTask={onNewTask} />
    </TaskContentGate>
  );
}

function TaskListContent({ onNewTask }: { onNewTask: () => void }) {
  const projectId = useLayout(focusedProject);
  const { scope } = useTaskOnlineScope();
  // An organization's tasks are assigned and filtered by project; Personal ones are nobody else's.
  const shared = scope && !scope.personal ? scope : null;
  const filters = useTaskListFilters(shared);
  const view = useLayout((state) => state.tasksView);
  const board = view === "board";
  const tasks = useTaskListSource(projectId, filters.assigned, board ? "active" : filters.shelf);
  const projects = useSpaceProjects();
  const { shelf, stage } = filters;
  const all = tasks.data;
  const list = all.filter(({ task }) => (shelf === "active" ? task.status !== "done" && task.status !== "archived" : task.status === shelf) && (!stage || task.status === stage));
  return (
    <>
      <TopBar
        actions={
          <>
            {shared && filters.assigned ? (
              <Button size="sm" onClick={() => filters.patch({ assigned: false })}>
                Assigned to me <X size={12} />
              </Button>
            ) : null}
            <Segmented size="sm" label="Tasks view" value={view} options={views} onChange={useLayout.getState().setTasksView} className="mr-1" />
            <TaskFilterMenu
              shelves={board ? undefined : { tasks: all, shelf, stage, onShelf: (value) => filters.patch({ shelf: value, stage: null }), onStage: (value) => filters.patch({ stage: value }) }}
              assignment={shared ? { value: filters.assigned, onChange: (value) => filters.patch({ assigned: value }) } : undefined}
              project={shared ? { id: projectId, projects: projects.data ?? [], onChange: (id) => useLayout.getState().setWorkspace(id ?? ALL_WORKSPACES) } : undefined}
            />
            <Button variant="primary" size="lg" className="ml-1 pl-2.5" onClick={onNewTask}>
              <Plus size={16} />
              New task
            </Button>
          </>
        }
      >
        <ScopedTitle>Tasks</ScopedTitle>
      </TopBar>
      <div className={board ? "task-board-page" : "page-column list-page"}>
        {taskListBody({
          error: tasks.error,
          loading: tasks.isLoading,
          board: board ? all.filter(({ task }) => task.status !== "archived") : null,
          list,
          shelf,
          stage,
          showProject: !projectId,
          projectId,
          memoryKey: filters.key,
          rowKey: filters.key ? JSON.stringify([filters.key, projectId, shelf, stage, filters.assigned]) : null,
          retry: () => void tasks.refetch(),
        })}
      </div>
    </>
  );
}
