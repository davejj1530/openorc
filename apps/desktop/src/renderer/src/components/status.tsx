import type { TaskPriority, TaskStatus } from "@openorc/protocol";
import { Archive, Check, CircleDashed, CircleHelp, CircleReview, Loader2, Minus, Signal, SignalHigh, SignalLow, SignalMedium } from "./icons";
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

export function StatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const c = cn("shrink-0", className);
  switch (status) {
    case "proposed":
      return <CircleHelp size={14} className={cn(c, "text-warn")} />;
    case "backlog":
      return <CircleDashed size={14} className={cn(c, "text-ink-4")} />;
    case "in_progress":
      return <Loader2 size={14} className={cn(c, "text-accent")} />;
    case "review":
      return <CircleReview size={14} className={cn(c, "text-review")} />;
    case "done":
      return <Check size={14} className={cn(c, "text-ok")} />;
    case "archived":
      return <Archive size={14} className={cn(c, "text-ink-4")} />;
  }
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
