import type { Project, Task } from "@openorc/protocol";
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

function TaskHistory({ task, project }: { task: Task; project: Project }) {
  const history = useRpc("runs.listForTask", { taskId: task.id });
  const [historyError, setHistoryError] = useState<string | null>(null);
  const conversation = useRpcMutation("tasks.openThread");
  const stop = useRpcMutation("runs.close");
  const actionError = conversation.error ?? stop.error;
  const latest = history.data?.at(-1);
  const stoppable = latest && ["starting", "running", "waiting", "idle"].includes(latest.state);
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
      if (!transcript?.live || transcript.hydrated) void runs.hydrate(run.id).catch(() => setHistoryError("Could not load task activity."));
    }
  }, [shown, history.data, transcripts]);
  let work: ReactNode = null;
  if (history.isError) work = <Button onClick={() => void history.refetch()}>Retry loading history</Button>;
  else if (shown && !merged) work = "Loading history…";
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="pb-4 flex flex-wrap items-center gap-3">
        <p className="text-sm text-ink-3 flex-1">Task activity is saved here. Continue the work in its thread.</p>
        {stoppable ? (
          <Button disabled={stop.isPending} onClick={() => stop.mutate({ runId: latest.id })}>
            Stop agent
          </Button>
        ) : null}
        <Button disabled={conversation.isPending} onClick={() => conversation.mutate({ taskId: task.id }, { onSuccess: (thread) => openThread(thread.id) })}>
          Open thread
        </Button>
      </div>
      {actionError ? (
        <p role="alert" className="text-sm text-bad">
          {actionError.message}
        </p>
      ) : null}
      {historyError ? (
        <p role="alert" className="text-sm text-bad">
          {historyError}{" "}
          <Button
            onClick={() => {
              setHistoryError(null);
              void Promise.all((history.data ?? []).map((run) => runs.hydrate(run.id))).catch(() => setHistoryError("Could not load task activity."));
            }}
          >
            Retry
          </Button>
        </p>
      ) : null}
      <TaskTimeline taskId={task.id} projectId={task.projectId} className={cn("overflow-y-auto", shown ? "max-h-2/5 shrink-0" : "min-h-0")} />
      {hasWork ? (
        <TextButton className="mt-3 self-start text-sm text-ink-3" aria-expanded={shown} onClick={() => setChosen(!shown)}>
          {shown ? "Hide work" : "Show work"}
        </TextButton>
      ) : null}
      {shown && merged ? <Transcript run={merged} media={{ basePath: task.worktreePath ?? project.rootPath, fileScope: { kind: "task", id: task.id } }} /> : null}
      {work ? <div className="py-4 text-sm text-ink-3">{work}</div> : null}
    </div>
  );
}
