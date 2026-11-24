import type { ReactNode } from "react";
import { threadMarkMotion, threadStateMark, type RunTranscript, type ThreadStatus } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { StateMark } from "./StateMark";
import "../styles/together.css";

type StatusFields = Pick<ThreadSummary, "activity" | "session" | "unread" | "doneAt" | "backgroundCommands" | "owner"> & Partial<Pick<ThreadSummary, "prUrl" | "prState">>;

/**
 * A thread's cube in its row's 16px slot, by the shared rule (threadStateMark): how it moves is the work under way,
 * amber is the person's turn, red a failure, the whole cube a result waiting unread. `subthreads` is what its sub
 * threads are doing, shown when it is more pressing than the thread's own state; `run` is its live run, which names
 * the work. `pull` lets a resting thread show its pull request. With nothing to report, `idle` shows.
 */
export function ThreadStatusIndicator({
  thread,
  subthreads = null,
  run,
  pull = false,
  idle = null,
  className,
}: {
  thread: StatusFields;
  subthreads?: ThreadStatus | null;
  run?: RunTranscript | undefined;
  pull?: boolean;
  idle?: ReactNode;
  className?: string;
}) {
  const shown = threadStateMark(pull ? thread : { ...thread, prUrl: null }, { subthreads, run });
  if (!shown) return idle;
  return (
    <span role="img" aria-label={shown.label} data-tip={shown.label} data-mark={shown.kind} className={cn("thread-status size-4 shrink-0 inline-flex items-center justify-center", className)}>
      <StateMark motion={threadMarkMotion(shown.kind)} />
    </span>
  );
}
