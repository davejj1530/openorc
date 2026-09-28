import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Project, Task } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../lib/query";
import { openThread } from "../lib/router";
import { hydrate, useRuns } from "../lib/transcript";
import { TeamTaskConversation } from "./TeamConversation";
import { Transcript } from "./Transcript";
import { Button } from "./ui";

/** Retained task history has no separate composer. Conversation happens in a thread. */
export function TaskActivity({ task, project }: { task: Task; project: Project }) {
  const ownership = useRpc("orchestration.taskState", { taskId: task.id });
  const retained = Boolean(ownership.data?.ownerDeletedAt);
  const runtime = useRpc("orchestration.runtime", { threadId: task.threadId ?? "" }, { enabled: Boolean(ownership.data) && !retained });
  const savedRuntime = useRpc("orchestration.taskRuntime", { taskId: task.id }, { enabled: retained });
  const data = retained ? savedRuntime.data?.runtime : runtime.data;
  const selected = retained ? savedRuntime : runtime;
  if (ownership.isPending || ownership.isError)
    return <div className="p-6 text-sm text-ink-3">{ownership.isError ? <Button onClick={() => void ownership.refetch()}>Retry loading activity</Button> : "Loading activity…"}</div>;
  if (ownership.data) {
    if (!data)
      return (
        <div className="p-6 text-sm text-ink-3">{selected.isError || !selected.isPending ? <Button onClick={() => void selected.refetch()}>Retry loading activity</Button> : "Loading activity…"}</div>
      );
    return <TeamTaskConversation task={task} project={project} data={data} />;
  }
  return <TaskHistory task={task} project={project} />;
}

function TaskHistory({ task, project }: { task: Task; project: Project }) {
  const history = useRpc("runs.listForTask", { taskId: task.id });
  const [historyError, setHistoryError] = useState<string | null>(null);
  const conversation = useRpcMutation("tasks.openThread");
  const stop = useRpcMutation("runs.close");
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
      if (!transcript?.live || transcript.hydrated) void hydrate(run.id).catch(() => setHistoryError("Could not load task activity."));
    }
  }, [history.data, transcripts]);
  let historyPlaceholder: ReactNode = "No separate execution history. Work and replies appear in the thread.";
  if (history.isError) historyPlaceholder = <Button onClick={() => void history.refetch()}>Retry loading history</Button>;
  else if (history.isPending || history.data?.length) historyPlaceholder = "Loading history…";
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="px-6 py-4 flex items-center gap-3">
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
      {conversation.error || stop.error ? (
        <p role="alert" className="px-6 text-sm text-bad">
          {(conversation.error ?? stop.error)?.message}
        </p>
      ) : null}
      {historyError ? (
        <p role="alert" className="px-6 text-sm text-bad">
          {historyError}{" "}
          <Button
            onClick={() => {
              setHistoryError(null);
              void Promise.all((history.data ?? []).map((run) => hydrate(run.id))).catch(() => setHistoryError("Could not load task activity."));
            }}
          >
            Retry
          </Button>
        </p>
      ) : null}
      {merged ? (
        <Transcript run={merged} basePath={task.worktreePath ?? project.rootPath} fileScope={{ kind: "task", id: task.id }} />
      ) : (
        <div className="p-6 text-sm text-ink-3">{historyPlaceholder}</div>
      )}
    </div>
  );
}
