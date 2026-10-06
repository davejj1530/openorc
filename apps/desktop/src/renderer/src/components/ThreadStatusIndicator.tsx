import type { ReactNode } from "react";
import type { ThreadSummary } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { AlertCircle, CircleHelp, LoaderCircle } from "./icons";

type StatusFields = Pick<ThreadSummary, "activity" | "session" | "unread" | "doneAt">;

/** Live activity takes priority over session health, unread activity. With nothing to report, `idle` shows instead. */
export function ThreadStatusIndicator({ thread, idle = null, className }: { thread: StatusFields; idle?: ReactNode; className?: string }) {
  let label: string;
  let indicator;
  if (thread.activity === "waiting") {
    label = "Needs you";
    indicator = <CircleHelp size={14} className="text-warn" />;
  } else if (thread.activity === "running") {
    label = "Working";
    indicator = (
      <span className="inline-flex motion-safe:animate-spin">
        <LoaderCircle size={14} className="text-accent-ink" />
      </span>
    );
  } else if (thread.session.status === "lost" || thread.session.status === "error") {
    const status = thread.session.status === "lost" ? "Session lost" : "Failed";
    label = thread.session.message ? `${status}: ${thread.session.message}` : status;
    indicator = <AlertCircle size={14} className="text-bad" />;
  } else if (thread.unread) {
    label = "Unread";
    indicator = <span className="size-1.5 rounded-full bg-ink" />;
  } else {
    return idle;
  }

  return (
    <span role="img" aria-label={label} title={label} className={cn("size-3.5 shrink-0 inline-flex items-center justify-center", className)}>
      {indicator}
    </span>
  );
}
