import { useMemo } from "react";
import type { ThreadSummary } from "@openorc/protocol";
import { useRun } from "../lib/transcript";
import { threadHeadline } from "./thread-headline";
import "./ThreadHeadline.css";

/**
 * A thread row's second line, only while there is something to say: the step its agent is on, what it is waiting
 * for, or what a finished turn came to. Idle rows stay one line.
 */
export function ThreadRowHeadline({ thread }: { thread: ThreadSummary }) {
  const run = useRun(thread.liveRunId ?? undefined);
  const headline = useMemo(() => threadHeadline(thread, run), [thread, run]);
  if (!headline) return null;
  return (
    <span className="thread-preview-headline" data-tone={headline.tone} title={headline.text}>
      {headline.text}
    </span>
  );
}
