import { useImperativeHandle, type ReactNode, type Ref } from "react";
import { ArrowUpRight, Check, GitBranch, MessageSquare } from "../components/icons";
import { harnessName, type Project, type Run, type Task, type TaskPriority, type TaskStatus, type TeamTaskView } from "@openorc/protocol";
import { DocumentEditor } from "../components/DocumentEditor";
import { PriorityIcon, StatusIcon, priorityLabel, priorityOrder, statusLabel, statusOrder } from "../components/status";
import { Button, Select, TextButton } from "../components/ui";
import { useTaskDocumentDraft } from "../lib/task-document-draft";
import { useRpcMutation } from "../lib/query";
import { openTask, openThread } from "../lib/router";
import { relativeTime } from "../lib/time";
import { TaskComments } from "../components/TaskComments";
import { TaskExecutionSettings, useTaskExecutionLocation } from "../components/TaskExecutionSettings";
import { TaskDelete } from "../components/TaskDelete";

export type TaskDocumentHandle = { flush: () => Promise<boolean> };

function taskActivityPrompt(team: boolean, assignmentCount: number, historyCount: number, openActivity: () => void): ReactNode {
  if (team)
    return (
      <TextButton tone="muted" className="mt-3 text-sm" onClick={openActivity}>
        {assignmentCount ? "View saved team activity and request history." : "View task activity and start it with its saved team."}
      </TextButton>
    );
  if (historyCount === 0) return <p className="mt-3 text-sm text-ink-3">Work on this task in its thread. Opening a thread does not start work.</p>;
  return null;
}

function taskDraftStatus(input: {
  draftStored: boolean;
  saveError: Error | null;
  flushError: string | null;
  hasTitle: boolean;
  imagesReady: boolean;
  saving: boolean;
  dirty: boolean;
  retry: () => void;
}): ReactNode {
  if (!input.draftStored) return <span className="text-bad">Local draft couldn’t be saved. Keep this task open until it saves.</span>;
  if (input.saveError)
    return (
      <span className="text-bad">
        Couldn’t save. Your draft is kept locally.{" "}
        <button className="underline" onClick={input.retry}>
          Retry
        </button>
      </span>
    );
  if (input.flushError)
    return (
      <span className="text-bad">
        {input.flushError}{" "}
        <button className="underline" onClick={input.retry}>
          Retry
        </button>
      </span>
    );
  if (!input.hasTitle) return "Add a title to save";
  if (!input.imagesReady) return "Images pending · draft kept locally";
  if (input.saving) return "Saving…";
  if (input.dirty) return "Unsaved changes · draft kept locally";
  return (
    <span className="inline-flex items-center gap-1.5">
      <Check size={12} /> Saved
    </span>
  );
}

/** The task's creation and recorded runs, with the way into its activity and conversation. */
function TaskHistory({
  task,
  history,
  team,
  openActivity,
  openConversation,
}: {
  task: Task;
  history: Run[];
  team: TeamTaskView | null | undefined;
  openActivity: () => void;
  openConversation: () => void;
}) {
  return (
    <section className="task-activity">
      <h2 className="text-base font-medium mb-4">Activity</h2>
      <div className="flex items-center gap-2 text-sm text-ink-3">
        <StatusIcon status="backlog" />
        <span>Created {relativeTime(task.createdAt)}</span>
      </div>
      {history.map((run) => (
        <button key={run.id} onClick={openActivity} className="flex items-start gap-2 text-left text-sm text-ink-2 hover:text-ink mt-4 max-w-full">
          <MessageSquare size={13} className="mt-0.5" />
          <span className="min-w-0">
            <span>
              {harnessName(run.agent)} · {run.state.replaceAll("_", " ")}
            </span>
            <span className="block text-ink-3 mt-0.5 line-clamp-2 break-words">{run.resultText || run.error || relativeTime(run.startedAt)}</span>
          </span>
          <ArrowUpRight size={12} className="mt-0.5" />
        </button>
      ))}
      {taskActivityPrompt(Boolean(team), team?.assignments.length ?? 0, history.length, openActivity)}
      {task.threadId || task.executionThreadId ? (
        <TextButton tone="muted" className="flex items-center gap-2 mt-4 text-sm" onClick={() => (team?.ownerDeletedAt ? openActivity() : openConversation())}>
          <MessageSquare size={13} /> {team?.ownerDeletedAt ? "Conversation deleted · open team activity" : "Open thread"}
          <ArrowUpRight size={12} />
        </TextButton>
      ) : null}
    </section>
  );
}

export function TaskDocument({ task, project, ref }: { task: Task; project: Project; ref?: Ref<TaskDocumentHandle> }) {
  const document = useTaskDocumentDraft(task);
  const { draft, patch, body, imagesReady, reportImagesReady, draftStored, dirty, saving, saveError, error: flushError, reportError: setFlushError, flush } = document;
  const conversation = useRpcMutation("tasks.openThread");
  const properties = useRpcMutation("tasks.update");
  const execution = useTaskExecutionLocation(task, flush);
  const { runs, team } = execution;
  const flushAll = async () => (await execution.wait()) && (await flush());
  useImperativeHandle(ref, () => ({ flush: flushAll }));
  const openConversation = async () => {
    if (!(await flushAll())) return;
    try {
      const thread = await conversation.mutateAsync({ taskId: task.id });
      openThread(thread.id);
    } catch (error) {
      setFlushError(error instanceof Error ? error.message : String(error));
    }
  };
  const openActivity = () =>
    void flushAll().then((ok) => {
      if (ok) openTask(task.id, "chat");
    });

  const history = runs.data ?? [];
  return (
    <div
      className="flex-1 min-h-0 flex flex-col"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && (e.key === "Enter" || e.key.toLowerCase() === "s")) {
          e.preventDefault();
          flush();
        }
      }}
    >
      <div className="task-scroll">
        <article className="task-document">
          <textarea rows={1} aria-label="Task title" className="document-title" value={draft.title} onChange={(e) => patch({ title: e.target.value.replace(/\n/g, " ") })} onBlur={flush} />
          <div className="task-properties" aria-label="Task properties">
            <label className="property-chip">
              <StatusIcon status={task.status} />
              <Select
                aria-label="Status"
                className="property-select"
                value={task.status}
                disabled={properties.isPending}
                onChange={(e) => properties.mutate({ id: task.id, patch: { status: e.target.value as TaskStatus } })}
              >
                {statusOrder.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel[s]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="property-chip">
              <PriorityIcon priority={task.priority} />
              <Select
                aria-label="Priority"
                className="property-select"
                value={task.priority}
                disabled={properties.isPending}
                onChange={(e) => properties.mutate({ id: task.id, patch: { priority: e.target.value as TaskPriority } })}
              >
                {priorityOrder.map((p) => (
                  <option key={p} value={p}>
                    {priorityLabel[p]}
                  </option>
                ))}
              </Select>
            </label>
            <span className="property-chip truncate" title={project.name}>
              {project.name}
            </span>
          </div>
          {properties.error ? (
            <p role="alert" className="text-sm text-bad mb-3">
              {properties.error.message}
            </p>
          ) : null}
          <DocumentEditor ref={body} value={draft.spec} onChange={(spec) => patch({ spec })} onReadyChange={reportImagesReady} />
          <div className="flex flex-wrap items-center gap-3 mt-6 text-sm text-ink-3">
            <label className="flex min-w-0 items-center gap-2">
              <span>Labels</span>
              <input
                aria-label="Labels"
                className="bg-transparent py-1 text-ink-2 placeholder:text-ink-4"
                placeholder="Add labels, comma separated"
                value={draft.labels}
                onChange={(e) => patch({ labels: e.target.value })}
                onBlur={flush}
              />
            </label>
          </div>
          <TaskComments key={task.id} taskId={task.id} description={draft.spec} beforeSend={flushAll} />
          <TaskExecutionSettings execution={execution} />
          <TaskHistory task={task} history={history} team={team.data} openActivity={openActivity} openConversation={() => void openConversation()} />
          {team.data ? null : <TaskDelete task={task} />}
        </article>
      </div>
      <footer className="document-footer">
        <div className="text-sm text-ink-3 min-w-0" role="status">
          {taskDraftStatus({ draftStored, saveError, flushError, hasTitle: Boolean(draft.title.trim()), imagesReady, saving, dirty, retry: flush })}
        </div>
        <span className="hidden sm:inline-flex items-center gap-1.5 min-w-0 max-w-64 text-xs text-ink-3" title={execution.branch ?? undefined}>
          <GitBranch size={12} />
          <span className="truncate">{execution.branch ?? (execution.mode === "worktree" ? "Isolated worktree on start" : "Local checkout")}</span>
        </span>
        <Button disabled={saving || conversation.isPending || execution.isPending} onClick={() => void openConversation()}>
          Open thread <ArrowUpRight size={13} />
        </Button>
      </footer>
    </div>
  );
}
