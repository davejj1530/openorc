import { useState, type ReactNode } from "react";
import type { Block } from "@openorc/client";
import { WorkTranscript } from "../components/Transcript";
import { cn } from "../lib/cn";
import { useMounted } from "../lib/use-mounted";

/** A first message on its way to OpenOrc Cloud: what New thread shows from Send until the thread is there to open. */
export interface CloudStart {
  text: string;
  attachments: string[];
  at: number;
}

/**
 * A cloud start as the thread it is becoming: the message as sent, and the start's step under it, until the server holds
 * the thread and it opens with its own steps. A start that fails gives the composer back with its words and the draft.
 */
export function NewThreadStarting({ start }: { start: CloudStart }) {
  const blocks: Block[] = [
    { id: "start-message", kind: "message", role: "user", text: start.text, streaming: false, pending: true, at: start.at, ...(start.attachments.length ? { attachments: start.attachments } : {}) },
    { id: "start-thread", kind: "activity", label: "Starting the thread", status: "running", text: "", at: start.at },
  ];
  return (
    <div className="new-thread-starting" aria-busy>
      <WorkTranscript runId="new-thread" blocks={blocks} live />
    </div>
  );
}

/**
 * New thread's start on OpenOrc Cloud: `run` shows the message and the start's step for as long as `starting` takes,
 * where the thread will be, and the landing again if it fails. A start on this Mac opens its thread at once, so it shows
 * none.
 */
export function useCloudStart(): { start: CloudStart | null; run: <T>(cloud: boolean, message: Omit<CloudStart, "at">, starting: Promise<T>) => Promise<T> } {
  const [start, setStart] = useState<CloudStart | null>(null);
  const mounted = useMounted();
  return {
    start,
    run: (cloud, message, starting) => {
      if (!cloud) return starting;
      setStart({ ...message, at: Date.now() });
      return starting.finally(() => {
        if (mounted.current) setStart(null);
      });
    },
  };
}

/**
 * New thread's landing, kept but hidden while a cloud start shows in its place, so a failed start gives it back as it was.
 * Its wrapper takes no box of its own: the mark, the question and the composer stay the column's own children, with its
 * gap and their own alignment.
 */
export function NewThreadStage({ start, children }: { start: CloudStart | null; children: ReactNode }) {
  return (
    <>
      {start ? <NewThreadStarting start={start} /> : null}
      <div className={cn("contents", start && "hidden")}>{children}</div>
    </>
  );
}
