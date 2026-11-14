import type { ReactNode } from "react";
import { threadStatus, threadTreeStatus, type ThreadStatus } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { WorkingCube } from "./OpenOrcMark";
import { AskMark, BackgroundMark, FailedMark, UnreadMark } from "./StateMarks";

type StatusFields = Pick<ThreadSummary, "activity" | "session" | "unread" | "doneAt" | "backgroundCommands" | "owner">;

const indicators: Record<ThreadStatus["kind"], ReactNode> = {
  waiting: <AskMark className="text-attention" />,
  "waiting-other": <AskMark className="text-ink-3" />,
  running: <WorkingCube />,
  failed: <FailedMark className="text-bad" />,
  unread: <UnreadMark />,
  background: <BackgroundMark className="text-ink-3" />,
};

/**
 * A thread's mark in its row's 16px slot, by the shared row rule, each a solid shape with one cut: an amber disc with a
 * question while it needs you, a red triangle on failure, a rounded square with a prompt in the third ink while
 * commands the agent left running go on, and a 7px ink dot when a result waits unread. The working cube while an agent
 * works. `subthreads` is what its sub
 * threads are doing, shown when it is more pressing than the thread's own state. With nothing to report, `idle` shows.
 */
export function ThreadStatusIndicator({ thread, subthreads = null, idle = null, className }: { thread: StatusFields; subthreads?: ThreadStatus | null; idle?: ReactNode; className?: string }) {
  const status = threadTreeStatus(threadStatus(thread), subthreads);
  if (!status) return idle;
  return (
    <span role="img" aria-label={status.label} data-tip={status.label} className={cn("thread-status size-4 shrink-0 inline-flex items-center justify-center", className)}>
      {indicators[status.kind]}
    </span>
  );
}
