import { useMemo, type ReactNode } from "react";
import type { ThreadSummary } from "@openorc/protocol";
import { useRun } from "../lib/client";
import { threadHeadline, type ThreadHeadline } from "@openorc/client";
import "./ThreadHeadline.css";

/** What a thread row says under its title while there is something to say: the step its agent is on, what it is waiting for, or what a finished turn came to. */
export function useRowHeadline(thread: ThreadSummary): ThreadHeadline | null {
  const run = useRun(thread.liveRunId ?? undefined);
  return useMemo(() => threadHeadline(thread, run), [thread, run]);
}

/** A thread row's second line, with `trailing` at its end: the row's mark, such as a working thread's spinner. */
export function ThreadRowHeadline({ headline, trailing }: { headline: ThreadHeadline; trailing?: ReactNode }) {
  return (
    <span className="thread-preview-headline-line">
      <span className="thread-preview-headline" data-tone={headline.tone} title={headline.text}>
        {headline.text}
      </span>
      {trailing}
    </span>
  );
}
