import { useEffect, useState } from "react";
import { ThreadRichText } from "./ThreadImages";
import { WorkAgent, WorkDelegate, WorkLive, AlertCircle, ArrowUpRight, Check, ChevronRight, GitBranch, LoaderCircle, Play } from "./icons";
import { statusLabel } from "./status";
import { Button, TextButton } from "./ui";
import { cn } from "../lib/cn";
import { useRpc, useRpcMutation } from "../lib/query";
import { openTask, openThread } from "../lib/router";
import { relativeTime } from "../lib/time";
import { hydrate, useRun } from "../lib/transcript";
import { taskActivity, taskCardStatusLabel, taskStepLabel } from "../lib/task-progress";

function taskActivityIcon({ waiting, failed, working, finished, successful }: { waiting: boolean; failed: boolean; working: boolean; finished: boolean; successful: boolean }) {
  if (waiting || failed) return <AlertCircle size={14} className={cn("shrink-0", failed ? "text-bad" : "text-warn")} />;
  if (working) return <WorkLive size={16} className="work-live" />;
  if (finished && successful) return <WorkAgent size={16} className="tool-icon" data-tone="agent" />;
  return <WorkDelegate size={16} className="tool-icon" data-tone="task" />;
}

function taskStepIcon({ failed, done, working }: { failed: boolean; done: boolean; working: boolean }) {
  if (failed) return <AlertCircle size={12} className="shrink-0 text-bad" />;
  if (done) return <Check size={12} className="shrink-0" />;
  return <LoaderCircle size={12} className={cn("shrink-0", working && "animate-spin")} />;
}

/**
 * A task as seen from its thread: live status, what changed, and the one
 * action that matters now (approve a proposal, or open it). Reads the task
 * by id so the card stays current wherever it appears.
 */
export function TaskCard({ taskId, compact = false }: { taskId: string; compact?: boolean }) {
  const task = useRpc("tasks.get", { id: taskId });
  const snapshots = useRpc("review.snapshots", { taskId }, { enabled: Boolean(task.data?.baseSha), staleTime: 10_000 });
  const start = useRpcMutation("tasks.start");
  const runs = useRpc("runs.listForTask", { taskId }, { enabled: Boolean(task.data) });
  const [expanded, setExpanded] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const t = task.data;
  const liveRun = runs.data?.at(-1);
  const liveTranscript = useRun(liveRun?.id);
  // The card shows the latest message, a waiting approval and the last three steps: the newest turn, and earlier
  // ones only until those are all here.
  useEffect(() => {
    setHistoryError(null);
    if (liveRun) void hydrate(liveRun.id, { turns: 1 }).catch(() => setHistoryError("Could not load the task's activity."));
  }, [liveRun?.id]);
  useEffect(() => {
    if (!liveRun || !liveTranscript?.hydrated || liveTranscript.fromTurn === 0) return;
    const shown = taskActivity(liveTranscript.blocks);
    if (shown.steps.length < 3 || !shown.message) void hydrate(liveRun.id, { fromTurn: liveTranscript.fromTurn - 1 }).catch(() => setHistoryError("Could not load the task's activity."));
  }, [liveRun, liveTranscript]);
  const activity = taskActivity(liveTranscript?.blocks ?? []);
  const finished = Boolean(liveRun?.endedAt);
  const waiting = !finished ? activity.approval : null;
  const failed = liveRun?.state === "error";
  const working = Boolean(liveRun) && t?.status === "in_progress" && !finished && !waiting;
  const message = activity.message?.text || liveRun?.resultText;
  const stateLabel = taskCardStatusLabel({ approvalKind: waiting?.approvalKind, runState: liveRun?.state, taskLabel: t ? statusLabel[t.status] : "" });
  if (!t)
    return task.isLoading ? (
      <div className={cn("surface-card my-2 h-14 rounded-xl border border-line bg-surface", compact && "my-0 h-12")} />
    ) : (
      <div className="my-2 text-sm text-ink-3">
        {task.error ? "Could not load this task." : "This task is no longer available."}
        {task.error ? (
          <button className="ml-2 underline" onClick={() => void task.refetch()}>
            Retry
          </button>
        ) : null}
      </div>
    );
  const latest = snapshots.data?.at(-1);
  const stat = latest?.diffStat;
  const proposed = t.status === "proposed";

  return (
    <div data-task-activity={taskId} className={cn("surface-card rounded-xl border bg-surface min-w-0", proposed ? "border-warn" : "border-line", compact ? "px-2.5 py-2" : "my-2 px-4 py-3")}>
      <div className="flex items-center gap-2 min-w-0">
        {taskActivityIcon({ waiting: Boolean(waiting), failed, working, finished, successful: liveRun?.state === "success" })}
        <button onClick={() => openTask(t.id)} className="flex-1 min-w-0 text-left text-base font-medium text-ink truncate hover:text-ink" title={t.title}>
          {t.title}
        </button>
        {proposed ? (
          <Button
            size="sm"
            disabled={start.isPending}
            onClick={() =>
              start.mutate(
                { taskId: t.id },
                {
                  onSuccess: (run) => {
                    if (run.threadId) openThread(run.threadId);
                  },
                },
              )
            }
          >
            <Play size={11} /> Start
          </Button>
        ) : (
          <TextButton onClick={() => openTask(t.id, t.status === "review" ? "files" : "spec")} tone="faint" title="Open task" aria-label={`Open ${t.title}`}>
            <ArrowUpRight size={14} />
          </TextButton>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-ink-3 min-w-0">
        <span role="status" className={cn("shrink-0", waiting && "text-warn", failed && "text-bad")}>
          {stateLabel}
        </span>
        {t.branch ? (
          <span className="inline-flex items-center gap-1 font-mono flex-1 min-w-0" title={t.branch}>
            <GitBranch size={11} className="shrink-0" /> <span className="truncate">{t.branch}</span>
          </span>
        ) : null}
        {stat && stat.files > 0 ? (
          <span className="font-mono tabular">
            {stat.files} file{stat.files === 1 ? "" : "s"} <span className="text-ok">+{stat.insertions}</span> <span className="text-bad">-{stat.deletions}</span>
          </span>
        ) : null}
        {t.costUsd > 0 ? <span className="font-mono tabular">${t.costUsd.toFixed(2)}</span> : null}
        <span className="tabular shrink-0 ml-auto">{relativeTime(t.updatedAt)}</span>
      </div>
      {!compact && message ? (
        <div className="mt-3 min-w-0">
          <div className={cn("text-sm text-ink-2 prose-chat break-words", expanded ? "max-h-72 overflow-auto" : "max-h-32 overflow-hidden")}>
            {/* The agent wrote this. ThreadRichText is the variant whose links ask before leaving. */}
            <ThreadRichText isAnimating={Boolean(activity.message?.streaming && !finished)}>{message}</ThreadRichText>
          </div>
          {message.length > 180 || message.split("\n").length > 3 ? (
            <TextButton tone="muted" className="mt-1 text-xs" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : "Read full update"}
            </TextButton>
          ) : null}
        </div>
      ) : null}
      {waiting ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-ink-2 min-w-0 break-words">
            {waiting.approvalKind === "user_input" ? "The agent needs your answer to continue." : `Paused before ${taskStepLabel(waiting.toolName ?? "this action").toLowerCase()}.`}
          </span>
          <Button size="sm" onClick={() => openTask(t.id, "chat")}>
            {waiting.approvalKind === "user_input" ? "Answer question" : "Review request"}
            <ArrowUpRight size={12} />
          </Button>
        </div>
      ) : null}
      {!compact && activity.steps.length > 0 ? (
        <details className="mt-2 text-xs text-ink-3 group/activity">
          <summary className="list-none flex items-center gap-1.5 cursor-pointer hover:text-ink-2">
            <ChevronRight size={12} className="group-open/activity:rotate-90 transition-transform" />
            Recent activity<span className="ml-auto truncate">{taskStepLabel(activity.steps.at(-1)!.name)}</span>
          </summary>
          <div className="mt-2 grid gap-1.5">
            {activity.steps.map((step) => (
              <div key={step.id} className="flex items-center gap-2 min-w-0">
                {taskStepIcon({ failed: Boolean(step.isError), done: step.done, working })}
                <span className="truncate">{taskStepLabel(step.name)}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {!message && working ? <div className="mt-2 text-sm text-ink-3">{activity.steps.length ? "The agent is working. Updates will appear here." : "Starting the agent…"}</div> : null}
      {failed && liveRun.error ? <div className="mt-2 text-sm text-bad break-words">{liveRun.error}</div> : null}
      {historyError || runs.error || task.error ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-bad">
          {historyError ?? "Could not refresh task activity."}
          <TextButton
            underline
            onClick={() => {
              void runs.refetch();
              void task.refetch();
              if (liveRun)
                void hydrate(liveRun.id, { turns: 1 })
                  .then(() => setHistoryError(null))
                  .catch(() => {});
            }}
          >
            Retry
          </TextButton>
        </div>
      ) : null}
      {!compact && proposed && t.spec ? <div className="mt-1.5 text-sm text-ink-2 line-clamp-3 whitespace-pre-wrap">{t.spec}</div> : null}
      {start.error ? <div className="mt-1 text-xs text-bad">{start.error.message}</div> : null}
    </div>
  );
}
