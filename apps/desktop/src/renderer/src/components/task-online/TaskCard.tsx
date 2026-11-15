import { useState } from "react";
import { relativeTime } from "@openorc/client";
import type { OnlineTask, OnlineTaskRef } from "@openorc/protocol";
import { useTaskOnlineQuery } from "../../lib/task-online-query";
import { useTaskContentGate } from "../../lib/task-content-gate";
import { useTaskOpenSeen } from "../../lib/task-open-seen";
import { useShownTaskActivity } from "../../lib/task-activity-shown";
import { openOnlineTask } from "../../lib/task-open";
import { spaceNavigation } from "../../lib/space-navigation";
import { cn } from "../../lib/cn";
import { taskActivityIcon, taskCardClass } from "../TaskCard";
import { ThreadRichText } from "../ThreadImages";
import { ArrowUpRight } from "../icons";
import { statusLabel } from "../status";
import { TextButton } from "../ui";
import { TaskFacts } from "./TaskFacts";
import { TaskThreadLink } from "./TaskThreadLink";

export function OnlineTaskCard({ reference }: { reference: OnlineTaskRef }) {
  const gate = useTaskContentGate(reference.spaceId);
  if (!gate.allowed) return <div className="my-2 text-sm text-ink-3">This task isn’t available here.</div>;
  return <OnlineTaskCardRead reference={reference} />;
}
function OnlineTaskCardRead({ reference }: { reference: OnlineTaskRef }) {
  const availability = useTaskOnlineQuery(reference, "tasks.online.state", { spaceId: reference.spaceId });
  // Reading a task needs only its space's delivery; opening its thread waits for execution in the thread link.
  const enabled = availability.data?.state === "ready" && availability.data.accountId === reference.accountId;
  const query = useTaskOnlineQuery(reference, "tasks.online.get", { spaceId: reference.spaceId, id: reference.id }, enabled);
  const task = enabled && !query.error ? query.data?.task : null;
  if (!task || task.projectId !== reference.projectId || task.spaceId !== reference.spaceId)
    return <div className="my-2 text-sm text-ink-3">{availability.isLoading || query.isLoading ? "Loading task…" : "This task isn’t available here."}</div>;
  return <OnlineTaskCardBody reference={reference} task={task} />;
}
function OnlineTaskCardBody({ reference, task }: { reference: OnlineTaskRef; task: OnlineTask }) {
  const [expanded, setExpanded] = useState(false);
  useTaskOpenSeen(reference, task, expanded);
  const activity = useShownTaskActivity(task.activity);
  const waiting = activity?.state === "waiting" && task.viewer.attention.includes("ask");
  const failed = activity?.state === "failed";
  const label = taskActivityLabel(task, activity);
  const message = activity?.latestMessage;
  return (
    <div data-task-activity={task.id} className={taskCardClass(false)}>
      <div className="flex items-center gap-2 min-w-0">
        {taskActivityIcon({ waiting, failed, working: activity?.state === "working", finished: activity?.state === "completed", successful: activity?.state === "completed" })}
        <button onClick={() => openCardTask(reference)} className="flex-1 min-w-0 text-left text-base text-ink truncate hover:text-ink" data-tip={task.title}>
          {task.title}
        </button>
        {task.status === "proposed" ? (
          <TaskThreadLink reference={reference} task={task} />
        ) : (
          <TextButton onClick={() => openCardTask(reference)} tone="faint" data-tip="Open task" aria-label={`Open ${task.title}`}>
            <ArrowUpRight size={14} />
          </TextButton>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-ink-3 min-w-0">
        <span role="status" className={cn("shrink-0", task.viewer.attention.includes("ask") && "text-warn", failed && "text-bad")}>
          {label}
        </span>
        <TaskFacts task={task} />
        <span className="tabular shrink-0 ml-auto">{relativeTime(task.updatedAt)}</span>
      </div>
      {message ? (
        <div className="mt-3 min-w-0">
          <div className={cn("text-sm text-ink-2 prose-chat break-words", expanded ? "max-h-72 overflow-auto" : "max-h-32 overflow-hidden")}>
            <ThreadRichText>{message}</ThreadRichText>
          </div>
          {message.length > 180 || message.split("\n").length > 3 ? (
            <TextButton tone="muted" className="mt-1 text-xs" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : "Read full update"}
            </TextButton>
          ) : null}
        </div>
      ) : null}
      {activity?.waitingFor ? <p className="mt-3 text-sm text-ink-2 break-words">{activity.waitingFor}</p> : null}
      {activity?.lastAction ? (
        <details className="mt-2 text-xs text-ink-3" onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary>Recent activity</summary>
          <p className="mt-2 break-words">{activity.lastAction}</p>
        </details>
      ) : null}
      {task.execution.state === "unavailable" ? <p className="mt-2 text-sm text-ink-3">Thread unavailable</p> : null}
      {task.createdIn.state === "private" ? <p className="mt-2 text-sm text-ink-3">Private thread</p> : null}
    </div>
  );
}
function openCardTask(reference: OnlineTaskRef): void {
  const navigation = spaceNavigation.getState();
  if (!navigation.inventory.some((space) => space.id === reference.spaceId && space.accountId === reference.accountId)) return;
  if (navigation.current !== reference.spaceId) navigation.select(reference.spaceId);
  openOnlineTask(reference);
}
function taskActivityLabel(task: OnlineTask, activity: OnlineTask["activity"]): string {
  switch (activity?.state) {
    case "waiting":
      return "Waiting";
    case "failed":
      return "Run failed";
    case "cancelled":
      return "Stopped";
    default:
      return statusLabel[task.status];
  }
}
