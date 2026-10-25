import { publishView, teamGitActions, type PublishInput } from "@openorc/client";
import { useEffect, useRef, useState } from "react";
import { useLinkState } from "../client";
import { linkReason } from "../connection/link-reason";
import { settleLost, type Publishing } from "./publish-state";
import { changeDrafts, publishStore, usePublishing } from "./publishing";
import type { ChangesReads } from "./use-changes";

/** Outside a team every step is the person's own; a team's thread shows no bar on the phone. */
const SOLO = teamGitActions(false, { isPending: false, isError: false });

function uncommittedOf(reads: ChangesReads): PublishInput["uncommitted"] {
  if (reads.uncommitted.data) return { files: reads.uncommitted.data.totals.files };
  return reads.uncommitted.error ? "failed" : "loading";
}

function runningOf(publishing: Publishing): PublishInput["running"] {
  if (publishing.kind === "running") return publishing.action;
  return publishing.kind === "lost" ? publishing.lost.action : null;
}

type Read = { data?: unknown; dataUpdatedAt: number; isFetching: boolean };
const freshSince = (at: number, read: Read) => read.data !== undefined && read.dataUpdatedAt > at && !read.isFetching;

/**
 * Once the link is back and no Git write holds the workspace, says what a lost write did. The Mac keeps going without
 * the phone, so a write still running (a long hook, an upload, gh) is waited for. The log and the thread are then read
 * again, so neither answer comes from before the write landed.
 */
function useSettleLost(threadId: string, publishing: Publishing, reads: ChangesReads, connected: boolean): void {
  const { log, push, thread } = reads;
  const lost = connected && publishing.kind === "lost";
  const clear = lost && freshSince(publishStore.lostAt(threadId), push) && push.data?.busy === false;
  const [clearAt, setClearAt] = useState<number | null>(null);
  const latest = useRef({ log, thread });
  latest.current = { log, thread };
  useEffect(() => {
    if (!clear) {
      setClearAt(null);
      return;
    }
    setClearAt(push.dataUpdatedAt);
    // A refetch cancels one in flight, so what arrives was asked for after the Mac said the workspace is free.
    void latest.current.log.refetch();
    void latest.current.thread.refetch();
  }, [clear, push.dataUpdatedAt]);
  const ready = clear && clearAt !== null && freshSince(clearAt, log) && freshSince(clearAt, thread);
  useEffect(() => {
    if (!ready || publishing.kind !== "lost" || !log.data || !push.data || !thread.data) return;
    const outcome = settleLost(publishing.lost, { log: log.data, push: push.data, thread: thread.data });
    if (outcome.kind === "done" && publishing.lost.action === "commit") changeDrafts.setMessage(threadId, "");
    if (outcome.kind === "done" && publishing.lost.action === "pr") changeDrafts.clearPullRequest(threadId);
    publishStore.settle(threadId, outcome);
  }, [ready, publishing, log.data, push.data, thread.data, threadId]);
}

/** The thread's publish flow as the bar and its sheets show it, from the Changes screen's reads. */
export function usePublish(threadId: string, reads: ChangesReads) {
  const publishing = usePublishing(threadId);
  const linkState = useLinkState();
  const offline = linkReason(linkState);
  const thread = reads.thread.data ?? null;
  const project = reads.project.data ?? null;
  useSettleLost(threadId, publishing, reads, linkState.kind === "connected");
  const view =
    thread && project
      ? publishView({
          thread,
          project,
          uncommitted: uncommittedOf(reads),
          push: { state: reads.push.data, error: reads.push.error?.message ?? null },
          commits: reads.log.data?.length,
          gh: reads.gh.data?.installed,
          team: SOLO,
          running: runningOf(publishing),
          offline,
        })
      : null;
  return { publishing, view, offline, mac: linkState.kind === "unpaired" ? "your Mac" : linkState.mac.name };
}
