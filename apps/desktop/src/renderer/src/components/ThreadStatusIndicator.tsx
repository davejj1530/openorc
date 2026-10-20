import type { ReactNode } from "react";
import type { ThreadSummary } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { AlertCircle, CircleHelp, LoaderCircle } from "./icons";

type StatusFields = Pick<ThreadSummary, "activity" | "session" | "unread" | "doneAt">;

/**
 * A thread's mark in its row's 16px lead. Live activity takes priority over session health, then unread results:
 * an amber question while it needs you, a faint spinner while it works (muted on the open row), red on failure,
 * and a 7px attention dot that settles with one overshoot when a result waits. With nothing to report, `idle` shows.
 */
export function ThreadStatusIndicator({ thread, idle = null, className }: { thread: StatusFields; idle?: ReactNode; className?: string }) {
  let label: string;
  let indicator;
  if (thread.activity === "waiting") {
    label = "Needs you";
    indicator = <CircleHelp size={14} className="text-attention" />;
  } else if (thread.activity === "running") {
    label = "Working";
    indicator = (
      <span className="thread-status-spinner inline-flex motion-safe:animate-spin">
        <LoaderCircle size={14} />
      </span>
    );
  } else if (thread.session.status === "lost" || thread.session.status === "error") {
    const status = thread.session.status === "lost" ? "Session lost" : "Failed";
    label = thread.session.message ? `${status}: ${thread.session.message}` : status;
    indicator = <AlertCircle size={14} className="text-bad" />;
  } else if (thread.unread) {
    label = "Unread";
    indicator = <span className="thread-status-dot size-1.75 rounded-full bg-attention" />;
  } else {
    return idle;
  }

  return (
    <span role="img" aria-label={label} title={label} className={cn("thread-status size-4 shrink-0 inline-flex items-center justify-center", className)}>
      {indicator}
    </span>
  );
}
