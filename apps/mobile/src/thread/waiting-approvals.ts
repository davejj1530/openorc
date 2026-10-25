import type { Block } from "@openorc/client";
import type { InboxList } from "@openorc/protocol";
import { useEffect, useMemo, useRef } from "react";
import { client, useRpc } from "../client";

type ApprovalBlock = Extract<Block, { kind: "approval" }>;

/** A run of this thread that the conversation has not loaded, and what it asks of the person. */
export interface WaitingApproval {
  runId: string;
  /** The task's title for a run of one of the thread's tasks, which its alert carried; null for the thread's own runs. */
  task: string | null;
  blocks: ApprovalBlock[];
}

/**
 * The runs of this thread and of its tasks that wait on the person, as the Mac's inbox lists them, apart from the runs
 * the conversation has loaded. The Mac points their alerts at this thread, but the conversation opens on its newest run,
 * so a team lead's warm run waits here until the reader scrolls up to it, and a task's run, which it never shows, stays.
 */
export function waitingRuns(inbox: InboxList | undefined, threadId: string, shown: readonly string[]): { runId: string; task: string | null }[] {
  const loaded = new Set(shown);
  const waiting = new Map<string, string | null>();
  for (const item of inbox?.items ?? []) {
    if (item.reason !== "approval" || !item.runId || loaded.has(item.runId)) continue;
    if (item.kind === "task" ? item.task.threadId === threadId : item.thread.id === threadId) waiting.set(item.runId, item.kind === "task" ? item.task.title : null);
  }
  return [...waiting].map(([runId, task]) => ({ runId, task }));
}

const openApprovals = (blocks: readonly Block[]) => blocks.filter((block): block is ApprovalBlock => block.kind === "approval" && !block.decision);

/** Blocks are replaced, never changed, so the same blocks in the same order show the same thing. */
const sameApprovals = (a: readonly WaitingApproval[], b: readonly WaitingApproval[]) =>
  a.length === b.length &&
  a.every((item, i) => item.runId === b[i]!.runId && item.task === b[i]!.task && item.blocks.length === b[i]!.blocks.length && item.blocks.every((block, j) => block === b[i]!.blocks[j]));

/**
 * What waits on the person outside the conversation's loaded runs: each run's open approvals and questions, read from
 * its newest turn and kept live. The same array until one of them changes, so a frame that only streams text leaves
 * the transcript alone.
 */
export function useWaitingApprovals(threadId: string, shown: readonly string[]): WaitingApproval[] {
  const inbox = useRpc("inbox.list", {});
  const waiting = useMemo(() => waitingRuns(inbox.data, threadId, shown), [inbox.data, threadId, shown]);
  const runIds = useMemo(() => waiting.map((run) => run.runId), [waiting]);
  const transcripts = client.useRuns(runIds);
  const failed = client.useFailedLoads();
  useEffect(() => {
    for (const runId of runIds) {
      if (client.runs.get(runId)?.hydrated || failed.has(runId)) continue;
      client.runs.hydrate(runId, { turns: 1 }).catch(() => undefined);
    }
  }, [runIds, transcripts, failed]);
  const last = useRef<WaitingApproval[]>([]);
  return useMemo(() => {
    const next = waiting.flatMap(({ runId, task }, index) => {
      const blocks = openApprovals(transcripts[index]?.blocks ?? []);
      return blocks.length ? [{ runId, task, blocks }] : [];
    });
    if (!sameApprovals(next, last.current)) last.current = next;
    return last.current;
  }, [waiting, transcripts]);
}
