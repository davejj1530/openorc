import { useEffect, useRef } from "react";
import type { OnlineTask, OnlineTaskRef } from "@openorc/protocol";
import { useTaskOnlineQuery, useTaskOnlineScope } from "../../lib/task-online-query";
import { useTaskProjects } from "../../lib/task-list-source";
import { useTaskOnlineSave } from "../../lib/task-online-save";
import { useTaskOpenSeen } from "../../lib/task-open-seen";
import { TaskDraftProvider } from "../../lib/task-draft-context";
import { taskDraftPatch } from "../../lib/task-draft";
import { taskRefKey } from "../../lib/task-ref";
import { openOnlineTask } from "../../lib/task-open";
import { useLayout } from "../../lib/layout";
import { useRouter, type TaskTab } from "../../lib/router";
import type { TaskDocumentHandle } from "../../views/TaskDocument";
import { TaskWorkspace } from "../task-list/TaskWorkspace";
import { Button, Empty } from "../ui";
import { OnlineTaskDocument } from "./TaskDocument";
import { TaskOnlineHistory } from "./TaskHistory";
import { TaskContentGate } from "./TaskContentGate";

export function OnlineTaskView({ reference, tab }: { reference: OnlineTaskRef; tab: TaskTab }) {
  return (
    <TaskContentGate spaceId={reference.spaceId}>
      <OnlineTaskRead reference={reference} tab={tab} />
    </TaskContentGate>
  );
}

function OnlineTaskRead({ reference, tab }: { reference: OnlineTaskRef; tab: TaskTab }) {
  const { scope } = useTaskOnlineScope();
  const allowed = scope?.accountId === reference.accountId && scope.spaceId === reference.spaceId;
  const query = useTaskOnlineQuery(allowed ? reference : null, "tasks.online.get", { spaceId: reference.spaceId, id: reference.id });
  const projects = useTaskProjects(allowed ? reference : null);
  const task = query.data?.task;
  const visible = allowed && !query.error && task?.projectId === reference.projectId && task.id === reference.id ? task : null;
  if (!visible)
    return (
      <TaskWorkspace tab={tab} selectTab={() => {}} unavailableTitle={query.isLoading ? "Loading task…" : "Task unavailable"}>
        {query.isLoading ? (
          <div className="document-skeleton" aria-label="Loading task" />
        ) : (
          <Empty title="This task isn’t available here.">{allowed ? <Button onClick={() => void query.refetch()}>Try again</Button> : null}</Empty>
        )}
      </TaskWorkspace>
    );
  return (
    <OnlineTaskWorkspace
      key={taskRefKey(reference)}
      reference={reference}
      task={visible}
      tab={tab}
      projectName={projects.data?.find((project) => project.hostedProjectId === reference.projectId)?.name ?? ""}
    />
  );
}

function OnlineTaskWorkspace({ reference, task, tab, projectName }: { reference: OnlineTaskRef; task: OnlineTask; tab: TaskTab; projectName: string }) {
  const save = useTaskOnlineSave(reference, task);
  const editor = useRef<TaskDocumentHandle>(null);
  useTaskOpenSeen(reference, task, tab === "spec");
  useEffect(() => {
    useLayout.getState().setPanel(false);
  }, [tab, reference]);
  const selectTab = async (next: TaskTab) => {
    const route = useRouter.getState().route;
    if (next === tab || (tab === "spec" && editor.current && !(await editor.current.flush()))) return;
    if (useRouter.getState().route === route) openOnlineTask(reference, next);
  };
  return (
    <TaskDraftProvider taskId={taskRefKey(reference)} saveDraft={(draft) => save.controller.save(taskDraftPatch(draft))}>
      <TaskWorkspace task={save.state.task} tab={tab} selectTab={(next) => void selectTab(next)}>
        {tab === "spec" ? <OnlineTaskDocument ref={editor} reference={reference} projectName={projectName} save={save} /> : <OnlineTaskTab reference={reference} task={save.state.task} tab={tab} />}
      </TaskWorkspace>
    </TaskDraftProvider>
  );
}

function OnlineTaskTab({ reference, task, tab }: { reference: OnlineTaskRef; task: OnlineTask; tab: TaskTab }) {
  const context = useTaskOnlineQuery(reference, "tasks.online.context", { spaceId: reference.spaceId, id: reference.id }, tab === "memory");
  if (tab === "chat") return <TaskOnlineHistory reference={reference} task={task} />;
  if (tab === "memory") {
    if (context.isLoading) return <div className="document-skeleton" aria-label="Loading context" />;
    if (!context.error && context.data?.context) return <pre className="whitespace-pre-wrap break-words text-sm">{context.data.context}</pre>;
    return <Empty title="Project context isn’t available here." />;
  }
  return <Empty title={task.execution.state === "unavailable" ? "Thread unavailable" : "No execution yet"} />;
}
