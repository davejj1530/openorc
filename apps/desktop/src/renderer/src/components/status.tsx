import type { TaskPriority, TaskStatus } from "@openorc/protocol";
import { Archive, CircleCheck, Minus, Signal, SignalHigh, SignalLow, SignalMedium } from "./icons";
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

export function PriorityIcon({ priority, className }: { priority: TaskPriority; className?: string }) {
  const c = cn("shrink-0 text-ink-3", className);
  switch (priority) {
    case "none":
      return <Minus size={14} className={cn(c, "text-ink-4")} />;
    case "low":
      return <SignalLow size={14} className={c} />;
    case "medium":
      return <SignalMedium size={14} className={c} />;
    case "high":
      return <SignalHigh size={14} className={c} />;
    case "urgent":
      return <Signal size={14} className={cn(c, "text-bad")} />;
  }
}
