import { AutomationsMenu } from "../components/automations/AutomationsMenu";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { OnlineTaskRef, type Project, type Task, type ThreadSummary } from "@openorc/protocol";
import { Panel, type PanelContext } from "../components/Panel";
import { TaskActivity } from "../components/TaskActivity";
import { TaskWorkspace } from "../components/task-list/TaskWorkspace";
import { OnlineTaskView } from "../components/task-online/TaskView";
import { Button, Empty } from "../components/ui";
import { useRpc } from "../lib/client";
import { useLayout } from "../lib/layout";
import { openTask, useRouter, type TaskTab } from "../lib/router";
import { TaskDraftProvider } from "../lib/task-draft-context";
import { ChangesPanel } from "../panels/ChangesPanel";
import { CommitsPanel } from "../panels/CommitsPanel";
import { MemoryPanel } from "../panels/MemoryPanel";
import { TaskDocument, type TaskDocumentHandle } from "./TaskDocument";

function executionUnavailableTitle(error: Error | null, pending: boolean): string {
  if (error) return "Execution conversation unavailable";
  if (pending) return "Loading execution conversation…";
  return "No execution yet";
}

function taskUnavailableContent(input: { loading: boolean; error: Error | null; retry: () => void }): ReactNode {
  if (input.loading) return <div className="document-skeleton" aria-label="Loading task" />;
  return (
    <Empty title={input.error ? "Task couldn’t load" : "Task not found"}>
      <Button onClick={input.retry}>Try again</Button>
    </Empty>
  );
}

/** Task documents and saved activity link out to their conversation. */
/**
 * One tab's page: the document, the activity, memory, or the execution conversation's changes and commits, which wait
 * for that conversation to exist.
 */
function TaskTabBody({
  tab,
  task,
  project,
  thread,
  owner,
  editor,
}: {
  tab: TaskTab;
  task: Task;
  project: Project;
  thread: ThreadSummary | null;
  owner: { error: Error | null; isPending: boolean; refetch: () => unknown };
  editor: RefObject<TaskDocumentHandle | null>;
}) {
  if (tab === "spec") return <TaskDocument ref={editor} task={task} project={project} />;
  if (tab === "chat") return <TaskActivity task={task} project={project} />;
  if (tab === "memory") return <MemoryPanel context={{ kind: "task", task, project }} />;
  if (!thread)
    return (
      <Empty title={executionUnavailableTitle(owner.error, owner.isPending)}>
        {owner.error ? <Button onClick={() => void owner.refetch()}>Try again</Button> : `${tab === "commits" ? "Commits" : "Changes"} will appear here when this task has an execution conversation.`}
      </Empty>
    );
  if (tab === "files") return <ChangesPanel thread={thread} task={task} project={project} />;
  return <CommitsPanel source={{ kind: "thread", thread, project }} />;
}

export function TaskView({ taskId, tab, taskRef }: { taskId: string; tab: TaskTab; taskRef?: OnlineTaskRef }) {
  if (taskRef) {
    const parsed = OnlineTaskRef.safeParse(taskRef);
    if (!parsed.success || parsed.data.id !== taskId) return <Empty title="This task isn’t available here." />;
    return <OnlineTaskView reference={parsed.data} tab={tab} />;
  }
  return <LocalTaskView taskId={taskId} tab={tab} />;
}

/** The task's automations in its top bar, for a task whose project has a folder on this computer, where automations run. */
function TaskAutomations({ task, project }: { task: Task | null | undefined; project: Project | null | undefined }) {
  return task && project?.rootPath ? <AutomationsMenu projectId={project.id} task={task} /> : null;
}

function LocalTaskView({ taskId, tab }: { taskId: string; tab: TaskTab }) {
  const task = useRpc("tasks.get", { id: taskId });
  const owner = useRpc("tasks.executionThread", { taskId }, { enabled: Boolean(task.data) });
  const project = useRpc("projects.get", { id: task.data?.projectId ?? "" }, { enabled: Boolean(task.data) });
  const setPanel = useLayout((s) => s.setPanel);
  const followProject = useLayout((s) => s.followProject);
  const t = task.data?.retiredTeam ? undefined : task.data;
  const p = project.data;
  const document = tab === "spec";
  const editor = useRef<TaskDocumentHandle>(null);
  const navigating = useRef(false);
  const selectTab = async (next: TaskTab) => {
    if (next === tab || navigating.current) return;
    navigating.current = true;
    try {
      if (document && editor.current && !(await editor.current.flush())) return;
      const route = useRouter.getState().route;
      if (route.view !== "task" || route.taskId !== taskId || route.tab !== tab) return;
      openTask(taskId, next);
    } finally {
      navigating.current = false;
    }
  };
  useEffect(() => {
    if (t) followProject(t.projectId);
  }, [t?.projectId, followProject]);
  useEffect(() => {
    setPanel(false);
  }, [tab, taskId, setPanel]);
  const thread = owner.data && !owner.data.teamInstanceId ? owner.data : null;
  const activityContext: PanelContext | null = t && p ? { kind: "task", task: t, project: p, thread: owner.data } : null;
  const body = activityContext ? (
    <TaskTabBody key={activityContext.task.id} tab={tab} task={activityContext.task} project={activityContext.project} thread={thread} owner={owner} editor={editor} />
  ) : null;
  return (
    <TaskDraftProvider key={taskId} taskId={taskId}>
      <TaskWorkspace
        task={activityContext?.task}
        tab={tab}
        panel={tab === "chat" && Boolean(activityContext)}
        selectTab={(next) => void selectTab(next)}
        actions={<TaskAutomations task={t} project={p} />}
      >
        {activityContext
          ? body
          : taskUnavailableContent({
              loading: task.isLoading || project.isLoading,
              error: task.error || project.error,
              retry: () => {
                void task.refetch();
                void project.refetch();
              },
            })}
      </TaskWorkspace>
      {/* After the task's thread is known, so a terminal doesn't start in the project folder first. */}
      {tab === "chat" && activityContext && !owner.isPending ? <Panel context={activityContext} /> : null}
    </TaskDraftProvider>
  );
}
