import type { ReactNode } from "react";
import { threadStatus, type ThreadStatus } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { AlertCircle, CircleHelp, LoaderCircle } from "./icons";

type StatusFields = Pick<ThreadSummary, "activity" | "session" | "unread" | "doneAt">;

const indicators: Record<ThreadStatus["kind"], ReactNode> = {
  waiting: <CircleHelp size={14} className="text-attention" />,
  running: (
    <span className="thread-status-spinner inline-flex motion-safe:animate-spin">
      <LoaderCircle size={14} />
    </span>
  ),
  failed: <AlertCircle size={14} className="text-bad" />,
  unread: <span className="thread-status-dot size-1.75 rounded-full bg-attention" />,
};

/**
 * A thread's mark in its row's 16px lead, by the shared row rule: an amber question while it needs you, a faint
 * spinner while it works (muted on the open row), red on failure, and a 7px attention dot that settles with one
 * overshoot when a result waits. With nothing to report, `idle` shows.
 */
export function ThreadStatusIndicator({ thread, idle = null, className }: { thread: StatusFields; idle?: ReactNode; className?: string }) {
  const status = threadStatus(thread);
  if (!status) return idle;
  return (
    <span role="img" aria-label={status.label} title={status.label} className={cn("thread-status size-4 shrink-0 inline-flex items-center justify-center", className)}>
      {indicators[status.kind]}
    </span>
  );
}
