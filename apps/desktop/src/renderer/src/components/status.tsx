import type { TaskPriority, TaskStatus } from "@openorc/protocol";
import { Archive, CircleCheck, Minus } from "./icons";
import { cn } from "../lib/cn";

export const statusLabel: Record<TaskStatus, string> = {
  proposed: "Proposed",
  backlog: "Backlog",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
  archived: "Archived",
};

export const statusOrder: TaskStatus[] = ["proposed", "backlog", "in_progress", "review", "done", "archived"];

/** The task list's group order: work under way first, then what waits on you, then the rest. */
export const groupOrder: TaskStatus[] = ["in_progress", "review", "proposed", "backlog", "done", "archived"];

/** A group heading may say more than the status's short name. */
export const groupLabel: Record<TaskStatus, string> = { ...statusLabel, review: "Ready for review" };

/**
 * A task's status as a 16px mark: an arc for work under way, the attention dot for review, an
 * attention ring for a proposal, an empty ring for the backlog, a check for done.
 */
export function StatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const c = cn("status-mark shrink-0", className);
  switch (status) {
    case "proposed":
      return <Ring className={cn(c, "text-attention")} />;
    case "backlog":
      return <Ring className={cn(c, "status-mark-empty")} />;
    case "in_progress":
      return (
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={c}>
          <circle cx="8" cy="8" r="6" strokeWidth="2" className="status-mark-track" />
          <circle cx="8" cy="8" r="6" strokeWidth="2" strokeLinecap="round" strokeDasharray="15 37.7" transform="rotate(-90 8 8)" stroke="currentColor" className="text-ink" />
        </svg>
      );
    case "review":
      return (
        <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" className={cn(c, "text-attention")}>
          <circle cx="8" cy="8" r="4" fill="currentColor" />
        </svg>
      );
    case "done":
      return <CircleCheck size={16} className={cn(c, "text-ok")} />;
    case "archived":
      return <Archive size={16} className={cn(c, "text-ink-4")} />;
  }
}

function Ring({ className }: { className: string }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <circle cx="8" cy="8" r="5.25" strokeWidth="1.5" stroke="currentColor" />
    </svg>
  );
}

export const priorityLabel: Record<TaskPriority, string> = { none: "No priority", low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };
export const priorityOrder: TaskPriority[] = ["none", "low", "medium", "high", "urgent"];

const priorityBars = ["M5 20v-3", "M10 20v-7", "M15 20V9", "M20 20V5"];
const priorityLit: Record<Exclude<TaskPriority, "none">, number> = { low: 1, medium: 2, high: 3, urgent: 4 };

/** A task's priority as signal bars: every bar is drawn, faint until its level lights it, so one lit bar still reads as a level. */
export function PriorityIcon({ priority, className }: { priority: TaskPriority; className?: string }) {
  const c = cn("shrink-0 text-ink-3", className);
  if (priority === "none") return <Minus size={14} className={cn(c, "text-ink-4")} />;
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      aria-hidden="true"
      className={cn("openorc-icon", c, priority === "urgent" && "text-bad")}
      data-icon="Priority"
    >
      {priorityBars.map((bar, index) => (
        <path key={bar} d={bar} opacity={index < priorityLit[priority] ? 1 : 0.28} />
      ))}
    </svg>
  );
}
