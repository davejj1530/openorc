import { useEffect, useRef, type ReactNode } from "react";
import { TaskActivity } from "../components/TaskActivity";
import { Panel, type PanelContext } from "../components/Panel";
import { StatusIcon } from "../components/status";
import { TopBar } from "../components/TopBar";
import { Button, Empty, TextButton } from "../components/ui";
import { useLayout } from "../lib/layout";
import { useRpc } from "../lib/query";
import { newThread, openTask, useRouter, type TaskTab } from "../lib/router";
import { TaskDocument, type TaskDocumentHandle } from "./TaskDocument";
import { TaskDraftProvider } from "../lib/task-draft-context";

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
export function TaskView({ taskId, tab }: { taskId: string; tab: TaskTab }) {
  const task = useRpc("tasks.get", { id: taskId });
  const owner = useRpc("tasks.executionThread", { taskId }, { enabled: Boolean(task.data) });
  const team = useRpc("orchestration.taskState", { taskId }, { enabled: Boolean(task.data?.threadId) });
  const project = useRpc("projects.get", { id: task.data?.projectId ?? "" }, { enabled: Boolean(task.data) });
  const setPanel = useLayout((s) => s.setPanel);
  const setProject = useLayout((s) => s.setProject);
  const t = task.data;
  const p = project.data;
  const document = tab === "spec";
  const editor = useRef<TaskDocumentHandle>(null);
  const navigating = useRef(false);
  const selectTab = async (next: TaskTab) => {
    if (next === tab || navigating.current) return;
    navigating.current = true;
    try {
      if (document && editor.current && !(await editor.current.flush())) return;
      openTask(taskId, next);
    } finally {
      navigating.current = false;
    }
  };
  useEffect(() => {
    if (t) setProject(t.projectId);
  }, [t?.projectId, setProject]);
  useEffect(() => {
    if (tab === "files") setPanel(true, "changes");
    else if (tab === "commits") setPanel(true, "commits");
    else if (tab === "memory") setPanel(true, "memory");
    else setPanel(false);
  }, [tab, taskId, setPanel]);
  let context: PanelContext | null = null;
  if (t && p) {
    if (team.data || owner.data?.teamInstanceId) context = { kind: "task", task: t, project: p };
    else if (owner.data) context = { kind: "thread", thread: owner.data, project: p, task: t };
  }
  return (
    <TaskDraftProvider key={taskId} taskId={taskId}>
      <main className="task-workspace workspace-main well flex-1 min-w-0 flex flex-col">
        <TopBar projectId={t?.projectId} projectName={p?.name} onProjectChange={(id) => newThread(id ?? undefined)} panel={!document && Boolean(context)}>
          <TextButton onClick={() => useRouter.getState().navigate({ view: "tasks" })} tone="muted">
            Tasks
          </TextButton>
          <span className="text-ink-4">/</span>
          {t ? (
            <>
              <StatusIcon status={t.status} />
              <span className="truncate" title={t.title}>
                {t.title}
              </span>
            </>
          ) : (
            <span>Loading task…</span>
          )}
        </TopBar>
        {t && p ? (
          <>
            <nav className="workspace-tabs" role="tablist" aria-label="Task workspace">
              {tabs.map((item) => (
                <button key={item.id} role="tab" aria-selected={tab === item.id} onClick={() => void selectTab(item.id)}>
                  {item.label}
                </button>
              ))}
            </nav>
            {document ? (
              <TaskDocument ref={editor} key={t.id} task={t} project={p} />
            ) : (
              <div className="flex-1 min-h-0">
                {(tab === "files" || tab === "commits") && !context ? (
                  <Empty title={executionUnavailableTitle(owner.error, owner.isPending)}>
                    {owner.error ? owner.error.message : "Changes will appear here when this task has an execution conversation."}
                  </Empty>
                ) : (
                  <TaskActivity key={t.id} task={t} project={p} />
                )}
              </div>
            )}
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
      {!document && context ? <Panel context={context} /> : null}
    </TaskDraftProvider>
  );
}
