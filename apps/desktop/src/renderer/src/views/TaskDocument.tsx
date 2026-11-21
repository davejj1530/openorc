import { relativeTime } from "@openorc/client";
import { harnessName, type Project, type Run, type Task, type TaskThreadLink, type ThreadSummary } from "@openorc/protocol";
import { useImperativeHandle, type ReactNode, type Ref } from "react";
import { TaskFooterActions } from "../components/task-buttons/TaskFooterActions";
import { ContinueThreadChooser, OpenThreadChooser } from "../components/task-threads/TaskThreadChoosers";
import { TaskThreadList } from "../components/task-threads/TaskThreadList";
import { TaskDocumentFields } from "../components/task-list/TaskDocumentFields";
import { useTaskRefine } from "../components/task-refine/TaskRefine";
import { ArrowUpRight, Check, GitBranch, MessageSquare } from "../components/icons";
import { StatusIcon } from "../components/status";
import { TaskComments } from "../components/TaskComments";
import { TaskDelete } from "../components/TaskDelete";
import { TaskExecutionSettings, useTaskExecutionLocation } from "../components/TaskExecutionSettings";
import { Button, TextButton } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { openTask, openThread } from "../lib/router";
import { useTaskDocumentDraft } from "../lib/task-document-draft";

export type TaskDocumentHandle = { flush: () => Promise<boolean> };

function taskActivityPrompt(historyCount: number): ReactNode {
  if (historyCount === 0) return <p className="mt-3 text-sm text-ink-3">Work on this task in its thread. Opening a thread does not start work.</p>;
  return null;
}

export function taskDraftStatus(input: {
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

/** The task's creation, its threads and recorded runs, with the way into its conversation. */
function TaskHistory({
  task,
  history,
  threads,
  openActivity,
  openConversation,
  continueInNewThread,
}: {
  task: Task;
  history: Run[];
  threads: readonly TaskThreadLink[];
  openActivity: () => void;
  openConversation: () => void;
  continueInNewThread: ReactNode;
}) {
  return (
    <section className="task-activity">
      <h2 className="text-base mb-4">Activity</h2>
      <div className="flex items-center gap-2 text-sm text-ink-3">
        <StatusIcon status="backlog" />
        <span>Created {relativeTime(task.createdAt)}</span>
      </div>
      <TaskThreadList links={threads} />
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
      {taskActivityPrompt(history.length + threads.length)}
      <div className="flex flex-wrap items-center gap-x-5">
        {task.threadId || task.executionThreadId ? (
          <TextButton tone="muted" className="flex items-center gap-2 mt-4 text-sm" onClick={openConversation}>
            <MessageSquare size={13} /> {"Open thread"}
            <ArrowUpRight size={12} />
          </TextButton>
        ) : null}
        {continueInNewThread}
      </div>
    </section>
  );
}

/** The current thread while it has worked and is quiet, so a new one can take over without resuming its long session. */
function continuableThread(links: readonly TaskThreadLink[]): ThreadSummary | null {
  const current = links.find((link) => link.current)?.thread;
  return current && current.hasStarted !== false && current.activity === "idle" ? current : null;
}

export function TaskDocument({ task, project, ref }: { task: Task; project: Project; ref?: Ref<TaskDocumentHandle> }) {
  const document = useTaskDocumentDraft(task);
  const { draft, imagesReady, draftStored, dirty, saving, saveError, error: flushError, reportError: setFlushError, flush } = document;
  const conversation = useRpcMutation("tasks.openThread");
  const threads = useRpc("tasks.threads", { taskId: task.id }).data ?? [];
  const continuable = continuableThread(threads);
  const properties = useRpcMutation("tasks.update");
  const execution = useTaskExecutionLocation(task, flush);
  const { runs } = execution;
  const basePath = task.worktreePath ?? project.rootPath;
  const refine = useTaskRefine(task.id, document, basePath, project);
  const flushAll = async () => (await execution.wait()) && (await flush());
  useImperativeHandle(ref, () => ({ flush: flushAll }));
  const openConversation = async () => {
    if (!(await flushAll())) return;
    try {
      openThread((await conversation.mutateAsync({ taskId: task.id })).id);
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
          <TaskDocumentFields
            document={document}
            status={task.status}
            priority={task.priority}
            projectName={project.name}
            pending={properties.isPending}
            error={properties.error?.message ?? null}
            basePath={basePath}
            refine={refine}
            onStatus={(status) => properties.mutate({ id: task.id, patch: { status } })}
            onPriority={(priority) => properties.mutate({ id: task.id, patch: { priority } })}
          />
          <TaskComments key={task.id} taskId={task.id} description={draft.spec} beforeSend={flushAll} />
          <TaskExecutionSettings execution={execution} />
          <TaskHistory
            task={task}
            history={history}
            threads={threads}
            openActivity={openActivity}
            openConversation={() => void openConversation()}
            continueInNewThread={continuable ? <ContinueThreadChooser task={task} thread={continuable} project={project} beforeOpen={flushAll} /> : null}
          />
          <TaskDelete task={task} />
        </article>
      </div>
      <footer className="document-footer">
        <div className="text-sm text-ink-3 min-w-0" role="status">
          {taskDraftStatus({ draftStored, saveError, flushError, hasTitle: Boolean(draft.title.trim()), imagesReady, saving, dirty, retry: flush })}
        </div>
        <span className="hidden sm:inline-flex items-center gap-1.5 min-w-0 max-w-64 text-xs text-ink-3" data-tip={execution.branch ?? undefined}>
          <GitBranch size={12} />
          <span className="truncate">{execution.branch ?? (execution.mode === "worktree" ? "Isolated worktree on start" : "Local checkout")}</span>
        </span>
        <TaskFooterActions task={task} buttons={project.settings.taskButtons ?? []} disabled={saving || execution.isPending} beforeRun={flushAll}>
          <Button disabled={saving || conversation.isPending || execution.isPending} onClick={() => void openConversation()}>
            Open thread <ArrowUpRight size={13} />
          </Button>
          <OpenThreadChooser task={task} project={project} runs={history} beforeOpen={flushAll} open={conversation.mutateAsync} />
        </TaskFooterActions>
      </footer>
    </div>
  );
}
