import { useRef, type ReactNode } from "react";
import type { Project, TaskStatus } from "@openorc/protocol";
import { Plus, X } from "../components/icons";
import { ScopedTitle } from "../components/ScopedTitle";
import { TopBar } from "../components/TopBar";
import { statusLabel } from "../components/status";
import { Segmented } from "../components/Segmented";
import { TaskBoard, type BoardPane } from "../components/task-board/TaskBoard";
import { TaskPane } from "../components/task-pane/TaskPane";
import { TASK_PANE_ID, useEscapeToClose, useOpenedTask } from "../components/task-pane/task-pane";
import { TaskRows } from "../components/task-list/TaskRows";
import { AutomationsMenu } from "../components/automations/AutomationsMenu";
import { TaskFilterMenu } from "../components/task-list/TaskFilterMenu";
import { Button, Empty } from "../components/ui";
import { ALL_WORKSPACES, focusedProject, useLayout } from "../lib/layout";
import { useTasksView, type TasksView } from "../lib/tasks-view";
import { useSpaceProjects } from "../lib/space-queries";
import { useTaskListSource } from "../lib/task-list-source";
import { useSharedBoard, type BoardOwner } from "../lib/task-board-source";
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
  /** Who keeps the columns the board shows: the project in scope's organization, or this computer for one in a folder here. */
  boardOwner: BoardOwner | null;
  pane: BoardPane;
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
  if (input.board) return <TaskBoard tasks={input.board} owner={input.boardOwner} showProject={input.showProject} pane={input.pane} />;
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

/** What the Tasks screen's top bar offers: the view switch, the board's automations, the filters and New task. */
function TaskListActions({
  filters,
  shared,
  boardProject,
  tasks,
  projectId,
  projects,
  onNewTask,
}: {
  filters: ReturnType<typeof useTaskListFilters>;
  /** An organization's tasks are in view, which are assigned and filtered by project. */
  shared: boolean;
  boardProject: string | null;
  tasks: TaskRecord[];
  projectId: string | null;
  projects: Project[];
  onNewTask: () => void;
}) {
  const view = useTasksView((state) => state.view);
  const board = view === "board";
  const { shelf, stage } = filters;
  return (
    <>
      {shared && filters.assigned ? (
        <Button size="sm" onClick={() => filters.patch({ assigned: false })}>
          Assigned to me <X size={12} />
        </Button>
      ) : null}
      <Segmented size="sm" label="Tasks view" value={view} options={views} onChange={useTasksView.getState().setView} className="mr-1" />
      {board && boardProject ? <AutomationsMenu projectId={boardProject} /> : null}
      <TaskFilterMenu
        shelves={board ? undefined : { tasks, shelf, stage, onShelf: (value) => filters.patch({ shelf: value, stage: null }), onStage: (value) => filters.patch({ stage: value }) }}
        assignment={shared ? { value: filters.assigned, onChange: (value) => filters.patch({ assigned: value }) } : undefined}
        project={shared ? { id: projectId, projects, onChange: (id) => useLayout.getState().setWorkspace(id ?? ALL_WORKSPACES) } : undefined}
      />
      <Button variant="primary" size="lg" className="ml-1 pl-2.5" onClick={onNewTask}>
        <Plus size={16} />
        New task
      </Button>
    </>
  );
}

function TaskListContent({ onNewTask }: { onNewTask: () => void }) {
  const projectId = useLayout(focusedProject);
  const { scope } = useTaskOnlineScope();
  // An organization's tasks are assigned and filtered by project; Personal ones are nobody else's.
  const shared = scope && !scope.personal ? scope : null;
  const filters = useTaskListFilters(shared);
  const view = useTasksView((state) => state.view);
  const board = view === "board";
  const tasks = useTaskListSource(projectId, filters.assigned, board ? "active" : filters.shelf);
  const projects = useSpaceProjects();
  const { shelf, stage } = filters;
  const all = tasks.data;
  // A board with columns of its own is one project's: shared by its organization when the server keeps boards, else kept
  // with its folder on this computer, which also keeps its automations.
  const sharedBoard = useSharedBoard(projectId);
  const localProject = projects.data?.find((project) => project.id === projectId && project.rootPath)?.id ?? null;
  const boardProject = sharedBoard ? null : localProject;
  const boardOwner: BoardOwner | null = sharedBoard ?? (boardProject ? { place: "local", projectId: boardProject } : null);
  const onBoard = board ? all.filter(({ task }) => task.status !== "archived") : null;
  const opened = useOpenedTask(onBoard);
  const screen = useRef<HTMLDivElement>(null);
  useEscapeToClose(screen, opened.task ? opened.close : null);
  const list = all.filter(({ task }) => (shelf === "active" ? task.status !== "done" && task.status !== "archived" : task.status === shelf) && (!stage || task.status === stage));
  return (
    <div ref={screen} className="relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar
          // With a task open beside the board, its pane holds the window's end.
          rightmost={opened.task ? false : undefined}
          actions={<TaskListActions filters={filters} shared={Boolean(shared)} boardProject={boardProject} tasks={all} projectId={projectId} projects={projects.data ?? []} onNewTask={onNewTask} />}
        >
          <ScopedTitle>Tasks</ScopedTitle>
        </TopBar>
        <div className={board ? "task-board-page" : "page-column list-page"}>
          {taskListBody({
            error: tasks.error,
            loading: tasks.isLoading,
            board: onBoard,
            list,
            shelf,
            stage,
            showProject: !projectId,
            boardOwner,
            pane: { id: TASK_PANE_ID, opened: opened.task?.id ?? null, onOpen: opened.toggle },
            memoryKey: filters.key,
            rowKey: filters.key ? JSON.stringify([filters.key, projectId, shelf, stage, filters.assigned]) : null,
            retry: () => void tasks.refetch(),
          })}
        </div>
      </div>
      <TaskPane task={opened.task} project={projects.data?.find((project) => project.id === opened.task?.projectId)} onClose={opened.close} />
    </div>
  );
}
