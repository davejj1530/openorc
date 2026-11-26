import type { Project, Run, Task } from "@openorc/protocol";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { runs, useRpc, useRpcMutation, useRuns } from "../lib/client";
import { openThread } from "../lib/router";
import { cn } from "../lib/cn";
import { TaskTimeline } from "./TaskTimeline";
import { Transcript } from "./Transcript";
import { Button, TextButton } from "./ui";

/**
 * A task's history as a timeline, with the agents' own work behind Show work: open already while that work waits on
 * the person, so what it asks is in view. Retained work has no separate composer. Conversation happens in a thread.
 */
export function TaskActivity({ task, project }: { task: Task; project: Project }) {
  return <TaskHistory task={task} project={project} />;
}

const LOAD_FAILED = "Could not load task activity.";

/**
 * The runs that worked on a task, joined as one transcript. Their work is shown once the person asks for it, and from
 * the start while it waits on them; shown, each run is loaded in full.
 */
function useTaskWork(task: Pick<Task, "id" | "approval">) {
  const history = useRpc("runs.listForTask", { taskId: task.id });
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<boolean | null>(null);
  const hasWork = Boolean(history.data?.length);
  const shown = hasWork && (chosen ?? Boolean(task.approval));
  const transcripts = useRuns((history.data ?? []).map((run) => run.id));
  const merged = useMemo(() => {
    const parts = transcripts.flatMap((transcript) => transcript ?? []);
    const last = parts.at(-1);
    return last ? { ...last, blocks: parts.flatMap((part) => part.blocks) } : null;
  }, [transcripts]);
  useEffect(() => {
    if (!shown) return;
    for (const [index, run] of (history.data ?? []).entries()) {
      const transcript = transcripts[index];
      // A run seen live from its start is already whole; hydrate skips any other run loaded in full.
      if (!transcript?.live || transcript.hydrated) void runs.hydrate(run.id).catch(() => setError(LOAD_FAILED));
    }
  }, [shown, history.data, transcripts]);
  const retry = () => {
    setError(null);
    void Promise.all((history.data ?? []).map((run) => runs.hydrate(run.id))).catch(() => setError(LOAD_FAILED));
  };
  return { history, hasWork, shown, toggle: () => setChosen(!shown), merged, error, retry };
}

/** Stop the agent while its latest run is under way, and the way to the task's thread, where the conversation is. */
function TaskWorkActions({ taskId, latest }: { taskId: string; latest: Run | undefined }) {
  const conversation = useRpcMutation("tasks.openThread");
  const stop = useRpcMutation("runs.close");
  const error = conversation.error ?? stop.error;
  return (
    <>
      <div className="pb-4 flex flex-wrap items-center gap-3">
        <p className="text-sm text-ink-3 flex-1">Task activity is saved here. Continue the work in its thread.</p>
        {latest && ["starting", "running", "waiting", "idle"].includes(latest.state) ? (
          <Button disabled={stop.isPending} onClick={() => stop.mutate({ runId: latest.id })}>
            Stop agent
          </Button>
        ) : null}
        <Button disabled={conversation.isPending} onClick={() => conversation.mutate({ taskId }, { onSuccess: (thread) => openThread(thread.id) })}>
          Open thread
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-bad">
          {error.message}
        </p>
      ) : null}
    </>
  );
}

function TaskHistory({ task, project }: { task: Task; project: Project }) {
  const { history, hasWork, shown, toggle, merged, error, retry } = useTaskWork(task);
  let note: ReactNode = null;
  if (history.isError) note = <Button onClick={() => void history.refetch()}>Retry loading history</Button>;
  else if (shown && !merged) note = "Loading history…";
  return (
    <div className="h-full flex flex-col min-h-0">
      <TaskWorkActions taskId={task.id} latest={history.data?.at(-1)} />
      {error ? (
        <p role="alert" className="text-sm text-bad">
          {error} <Button onClick={retry}>Retry</Button>
        </p>
      ) : null}
      <TaskTimeline taskId={task.id} projectId={task.projectId} className={cn("overflow-y-auto", shown ? "max-h-2/5 shrink-0" : "min-h-0")} />
      {hasWork ? (
        <TextButton className="mt-3 self-start text-sm text-ink-3" aria-expanded={shown} onClick={toggle}>
          {shown ? "Hide work" : "Show work"}
        </TextButton>
      ) : null}
      {shown && merged ? <Transcript run={merged} media={{ basePath: task.worktreePath ?? project.rootPath, fileScope: { kind: "task", id: task.id } }} /> : null}
      {note ? <div className="py-4 text-sm text-ink-3">{note}</div> : null}
    </div>
  );
}
