import { useMemo } from "react";
import { relativeTime, taskTimeline, type TaskLineLead } from "@openorc/client";
import { isHarnessId } from "@openorc/protocol";
import { useRpc } from "../lib/client";
import { openThread } from "../lib/router";
import { HarnessLogo } from "./HarnessLogo";
import { ArrowRight, CircleUser, MessageSquare } from "./icons";
import { WaitMark } from "./StateMarks";
import { statusLabel } from "./status";
import { TaskUpdate } from "./TaskUpdate";
import { TextButton } from "./ui";
import "./task-timeline.css";

function Lead({ lead }: { lead: TaskLineLead }) {
  if (lead.kind === "person") return <CircleUser size={15} />;
  if (lead.kind === "move") return <ArrowRight size={15} />;
  if (lead.kind === "asks") return <WaitMark className="text-attention" />;
  return isHarnessId(lead.agent) ? <HarnessLogo id={lead.agent} size={14} /> : <MessageSquare size={15} />;
}

/** A task's history, a line for each thing that happened to it. The work itself stays in its threads, which an agent's name opens. */
export function TaskTimeline({ taskId, projectId, className }: { taskId: string; projectId: string; className?: string }) {
  const events = useRpc("tasks.events", { taskId });
  const lines = useMemo(() => taskTimeline(events.data ?? [], statusLabel), [events.data]);
  if (events.isError)
    return (
      <p role="alert" className="text-sm text-bad">
        History couldn’t load. <TextButton onClick={() => void events.refetch()}>Try again</TextButton>
      </p>
    );
  if (lines.length === 0) return null;
  return (
    <ol className={className ? `task-timeline ${className}` : "task-timeline"} aria-label="Task history">
      {lines.map((line) => (
        <li key={line.id} className="task-timeline-entry">
          <div className="task-timeline-line">
            <span className="task-timeline-lead" aria-hidden="true">
              <Lead lead={line.lead} />
            </span>
            <span className="task-timeline-words">
              {line.words.map((word, index) =>
                word.threadId ? (
                  <button key={index} type="button" className="task-timeline-thread" onClick={() => openThread(word.threadId!)}>
                    {word.text}
                  </button>
                ) : (
                  <span key={index} data-strong={word.strong || undefined}>
                    {word.text}
                  </span>
                ),
              )}
            </span>
            <time className="task-timeline-at" dateTime={new Date(line.at).toISOString()}>
              {relativeTime(line.at)}
            </time>
          </div>
          {line.update ? <TaskUpdate taskId={taskId} projectId={projectId} eventId={line.id} update={line.update} /> : null}
        </li>
      ))}
    </ol>
  );
}
