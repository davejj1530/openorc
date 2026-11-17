import { hostedRunId, type ThreadSummary } from "@openorc/protocol";
import type { NativeThread } from "./wire-subthreads.js";
import type { WireEvent } from "./wire.js";

export function withNativeSummary(summary: ThreadSummary, row: NativeThread): ThreadSummary {
  if (!row.parentId) return summary;
  const child = row.nativeChild;
  const current = !row.nativeReadFailed && summary.owner?.reach === "live";
  const status = nativeStatus(row, current);
  const running = status === "running";
  return {
    ...summary,
    parentRelation: "subagent",
    parentThreadId: child?.parentId ?? row.parentId,
    activity: running ? "running" : "idle",
    liveRunId: running ? hostedRunId(row.id) : null,
    subagent: {
      status,
      agentType: child?.agentType ?? null,
      toolCallId: child?.toolCallId ?? null,
      startedAt: child ? Date.parse(child.startedAt) : summary.createdAt,
      endedAt: child?.endedAt ? Date.parse(child.endedAt) : null,
      stoppable: canStopNative(row, current),
      hostRunId: current ? (child?.hostRunId ?? null) : null,
    },
  };
}

function nativeStatus(row: NativeThread, current: boolean) {
  if (row.nativeReadFailed) return "no_updates";
  const status = row.nativeChild?.status ?? "no_updates";
  return status === "running" && !current ? "no_updates" : status;
}

function canStopNative(row: NativeThread, current: boolean): boolean {
  return Boolean(current && row.nativeChild?.status === "running" && row.nativeChild.stoppable && row.nativeChild.hostRunId);
}

/** Ownership is registered before a frame can expose a clickable child card. Detail reads replace these rows. */
export function nativeRowsFromEvents(parent: NativeThread, events: readonly WireEvent[], known: ReadonlySet<string>): NativeThread[] {
  const rows = new Map<string, NativeThread>();
  for (const { event } of events) {
    if (event["type"] !== "subagent.started" && event["type"] !== "subagent.updated") continue;
    const id = event["threadId"];
    if (typeof id !== "string" || !id || id === parent.id || known.has(id)) continue;
    rows.set(id, provisionalChild(parent, id, event));
  }
  return [...rows.values()];
}

function provisionalChild(parent: NativeThread, id: string, event: Record<string, unknown>): NativeThread {
  return {
    ...parent,
    id,
    parentId: parent.id,
    title: typeof event["title"] === "string" ? event["title"] : "Subagent",
    status: "idle",
    head: 0,
    turn: null,
    seenSeq: 0,
    lastAgentSeq: 0,
    pinnedAt: null,
    archivedAt: null,
    snoozedUntil: null,
    pullRequest: null,
    ask: null,
    waiting: [],
    backgroundCommands: [],
    nativeChild: undefined,
    nativeListKey: undefined,
    nativeReadFailed: true,
  };
}

/** A thread's id and every subthread's under it, however deep, among `rows`. */
export function withSubthreads(rows: readonly { id: string; parentId?: string | null }[], threadId: string): Set<string> {
  const ids = new Set([threadId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (row.parentId && ids.has(row.parentId) && !ids.has(row.id)) grew = Boolean(ids.add(row.id));
  }
  return ids;
}
