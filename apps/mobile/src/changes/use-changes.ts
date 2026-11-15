import type { ChangeComparison } from "@openorc/protocol";
import type { UseQueryResult } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { link, useLinkState, useRpc } from "../client";

/** The Commits section shows this many of the branch's newest commits. */
const LOG_LIMIT = 10;
/** Log and push state poll this often while the screen is in front, as the desktop's Commits tab does. */
const POLL_MS = 8_000;

/** Whether the app is in front; iOS freezes the link in the background anyway. */
export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState !== "background");
  useEffect(() => AppState.addEventListener("change", (state) => setActive(state === "active")).remove, []);
  return active;
}

/** Reads `queries` again each time the screen comes back into view: focused again, or the app active again. */
function useReadOnReturn(live: boolean, queries: Pick<UseQueryResult, "refetch">[]): void {
  const was = useRef(live);
  const latest = useRef(queries);
  latest.current = queries;
  useEffect(() => {
    if (live && !was.current) for (const query of latest.current) void query.refetch();
    was.current = live;
  }, [live]);
}

/**
 * What a thread's Changes screen reads from the Mac: the changes for the chosen comparison and always the uncommitted
 * ones (Commit counts those), the newest commits, what Push would send, and whether gh is there. Every
 * `threaddiff`/`threadlog` push refreshes them through their tags.
 */
export function useChangesReads(threadId: string, comparison: ChangeComparison) {
  const focused = useIsFocused();
  const active = useAppActive();
  const live = focused && active;
  const poll = live ? POLL_MS : false;
  const thread = useRpc("threads.get", { id: threadId });
  const projectId = thread.data?.projectId ?? "";
  const project = useRpc("projects.get", { id: projectId }, { enabled: Boolean(projectId) });
  const changes = useRpc("review.threadChanges", { threadId, comparison });
  const uncommitted = useRpc("review.threadChanges", { threadId, comparison: "head" });
  const log = useRpc("git.threadLog", { threadId, limit: LOG_LIMIT }, { refetchInterval: poll });
  const push = useRpc("git.threadPushState", { threadId }, { refetchInterval: poll });
  const gh = useRpc("system.gh", {});
  const reads = [thread, changes, uncommitted, log, push];
  useReadOnReturn(live, reads);
  const linkState = useLinkState();
  return {
    thread,
    project,
    changes,
    uncommitted,
    log,
    push,
    gh,
    /** Pull to refresh: everything again, or the connection now. */
    refresh: (): Promise<unknown> => (linkState.kind === "connected" ? Promise.all(reads.map((query) => query.refetch())) : link.retry()),
  };
}

export type ChangesReads = ReturnType<typeof useChangesReads>;
