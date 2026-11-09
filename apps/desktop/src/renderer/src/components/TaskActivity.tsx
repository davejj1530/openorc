import type { Project, Task } from "@openorc/protocol";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { runs, useRpc, useRpcMutation, useRuns } from "../lib/client";
import { openThread } from "../lib/router";
import { Transcript } from "./Transcript";
import { Button } from "./ui";

/** Retained task history has no separate composer. Conversation happens in a thread. */
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
  const transcripts = useRuns((history.data ?? []).map((run) => run.id));
  const merged = useMemo(() => {
    const parts = transcripts.flatMap((transcript) => transcript ?? []);
    const last = parts.at(-1);
    return last ? { ...last, blocks: parts.flatMap((part) => part.blocks) } : null;
  }, [transcripts]);
  useEffect(() => {
    for (const [index, run] of (history.data ?? []).entries()) {
      const transcript = transcripts[index];
      // A run seen live from its start is already whole; hydrate skips any other run loaded in full.
      if (!transcript?.live || transcript.hydrated) void runs.hydrate(run.id).catch(() => setHistoryError("Could not load task activity."));
    }
  }, [history.data, transcripts]);
  let historyPlaceholder: ReactNode = "No separate execution history. Work and replies appear in the thread.";
  if (history.isError) historyPlaceholder = <Button onClick={() => void history.refetch()}>Retry loading history</Button>;
  else if (history.isPending || history.data?.length) historyPlaceholder = "Loading history…";
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
      {merged ? (
        <Transcript run={merged} media={{ basePath: task.worktreePath ?? project.rootPath, fileScope: { kind: "task", id: task.id } }} />
      ) : (
        <div className="py-4 text-sm text-ink-3">{historyPlaceholder}</div>
      )}
    </div>
  );
}
