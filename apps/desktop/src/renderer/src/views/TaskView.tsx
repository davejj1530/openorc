import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { Project, Task, ThreadSummary } from "@openorc/protocol";
import { Panel, type PanelContext } from "../components/Panel";
import { StatusIcon } from "../components/status";
import { TabTrack } from "../components/TabTrack";
import { TaskActivity } from "../components/TaskActivity";
import { TopBar } from "../components/TopBar";
import { Button, Empty, TextButton } from "../components/ui";
import { useRpc } from "../lib/client";
import { useLayout } from "../lib/layout";
import { openTask, useRouter, type TaskTab } from "../lib/router";
import { TaskDraftProvider } from "../lib/task-draft-context";
import { ChangesPanel } from "../panels/ChangesPanel";
import { CommitsPanel } from "../panels/CommitsPanel";
import { MemoryPanel } from "../panels/MemoryPanel";
import { TaskDocument, type TaskDocumentHandle } from "./TaskDocument";

const tabs: { id: TaskTab; label: string }[] = [
  { id: "spec", label: "Overview" },
  { id: "chat", label: "Activity" },
  { id: "files", label: "Changes" },
  { id: "commits", label: "Commits" },
  { id: "memory", label: "Memory" },
];

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

export function TaskView({ taskId, tab }: { taskId: string; tab: TaskTab }) {
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
  const activityContext: PanelContext | null = t && p ? { kind: "task", task: t, project: p } : null;
  const body = t && p ? <TaskTabBody key={t.id} tab={tab} task={t} project={p} thread={thread} owner={owner} editor={editor} /> : null;
  return (
    <TaskDraftProvider key={taskId} taskId={taskId}>
      <main className="task-workspace workspace-main well flex-1 min-w-0 flex flex-col">
        <TopBar panel={tab === "chat" && Boolean(activityContext)}>
          <TextButton onClick={() => useRouter.getState().navigate({ view: "tasks" })} tone="muted">
            Tasks
          </TextButton>
          <span className="text-ink-4" aria-hidden="true">
            /
          </span>
          {t ? (
            <>
              <StatusIcon status={t.status} />
              <span className="truncate" data-tip={t.title}>
                {t.title}
              </span>
            </>
          ) : (
            <span>Loading task…</span>
          )}
        </TopBar>
        {t && p ? (
          <>
            <div className="task-tabs">
              <TabTrack label="Task workspace" items={tabs} value={tab} panelId="task-tab-content" onSelect={(next) => void selectTab(next)} />
            </div>
            <div id="task-tab-content" role="tabpanel" aria-label={tabs.find((item) => item.id === tab)?.label} className="task-tab-content flex-1 min-h-0 flex flex-col" data-tab={tab}>
              {document || tab === "files" ? body : <div className="task-tab-body">{body}</div>}
            </div>
          </>
        ) : (
          taskUnavailableContent({
            loading: task.isLoading || project.isLoading,
            error: task.error || project.error,
            retry: () => {
              void task.refetch();
              void project.refetch();
            },
          })
        )}
      </main>
      {tab === "chat" && activityContext ? <Panel context={activityContext} /> : null}
    </TaskDraftProvider>
  );
}
