import { useEffect, useState, type ReactNode } from "react";
import type { Block } from "@openorc/client";
import { isHostedAgent } from "@openorc/protocol";
import { WorkTranscript } from "../components/Transcript";
import { useRpc } from "../lib/client";
import { cn } from "../lib/cn";
import { core } from "../lib/rpc";
import { useMounted } from "../lib/use-mounted";

/** A first message on its way to OpenOrc Cloud: what New thread shows from Send until the thread is there to open. */
export interface CloudStart {
  text: string;
  attachments: string[];
  agent: string;
  at: number;
}

/**
 * A cloud start as the thread it is becoming: the message as sent, and the start's steps under it, until the server holds
 * the thread and it opens with its own steps. Sending the person's skills is one, counted while it lasts. A start that
 * fails gives the composer back with its words and the draft.
 */
export function NewThreadStarting({ start }: { start: CloudStart }) {
  const skills = useSkillsSending(start.agent);
  const blocks: Block[] = [
    { id: "start-message", kind: "message", role: "user", text: start.text, streaming: false, pending: true, at: start.at, ...(start.attachments.length ? { attachments: start.attachments } : {}) },
    skills
      ? { id: "start-skills", kind: "activity", label: "Sending your skills", status: "running", text: `${skills.sent} of ${skills.total}`, at: start.at }
      : { id: "start-thread", kind: "activity", label: "Starting the thread", status: "running", text: "", at: start.at },
  ];
  return (
    <div className="new-thread-starting" aria-busy>
      <WorkTranscript runId="new-thread" blocks={blocks} live />
    </div>
  );
}

/** How many of the agent's skills have gone up to OpenOrc Cloud, read again as each goes; null when none are going. */
function useSkillsSending(agent: string) {
  const hosted = isHostedAgent(agent) ? agent : null;
  const sending = useRpc("hostedSkills.sending", { agent: hosted ?? "claude" }, { enabled: hosted !== null, staleTime: 0 });
  const refetch = sending.refetch;
  useEffect(
    () =>
      core.onPush((event) => {
        if (event.type === "invalidate" && event.keys.includes("hostedSkillsSending")) void refetch();
      }),
    [refetch],
  );
  return sending.data ?? null;
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
