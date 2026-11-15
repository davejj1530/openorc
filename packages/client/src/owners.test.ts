import { mergeInbox, mergeThreadPages, OWNER_SESSION_METHODS, type HostPage, type InboxList, type ThreadSummary } from "@openorc/protocol";
import { ownerMark } from "./thread-row.js";
import { describe, expect, it } from "vitest";

function summary(id: string, lastActivityAt: number, extra: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id,
    projectId: "p",
    title: id,
    agent: "claude",
    model: null,
    effort: null,
    fastMode: false,
    mode: "act",
    permissionMode: "autonomous",
    workspaceMode: "worktree",
    branch: null,
    worktreePath: null,
    baseSha: null,
    baseBranch: null,
    pinnedAt: null,
    seenAt: null,
    doneAt: null,
    snoozedUntil: null,
    prUrl: null,
    prState: null,
    forkedFromId: null,
    forkedAtRunId: null,
    draft: null,
    importedFrom: null,
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt,
    archivedAt: null,
    activity: "idle",
    unread: false,
    session: { status: "idle", message: null },
    context: null,
    queued: [],
    lastAgentEventAt: null,
    taskCount: 0,
    openTaskCount: 0,
    ...extra,
  };
}

const mac = (rows: ThreadSummary[]): HostPage => ({ brain: "mac", reach: "live", heardAt: 5, rows });
const cloud = (rows: ThreadSummary[], reach: HostPage["reach"] = "live"): HostPage => ({ brain: "cloud", reach, heardAt: 4, rows });

describe("mergeThreadPages", () => {
  it("interleaves both hosts by activity and keeps the merged top of the page", () => {
    const merged = mergeThreadPages([mac([summary("m3", 30), summary("m1", 10)]), cloud([summary("c4", 40), summary("c2", 20)])], { limit: 3 }, "mac");
    expect(merged.map((row) => row.id)).toEqual(["c4", "m3", "c2"]);
  });

  it("marks only rows from another host, with how far it reaches", () => {
    const merged = mergeThreadPages([mac([summary("m", 2)]), cloud([summary("c", 1)], "asleep")], {}, "mac");
    expect(merged.map((row) => row.owner ?? null)).toEqual([null, { brain: "cloud", reach: "asleep", heardAt: 4 }]);
    expect(mergeThreadPages([mac([summary("m", 2)])], {}, null)[0]?.owner).toEqual({ brain: "mac", reach: "live", heardAt: 5 });
  });

  it("lists a thread caught between hosts once, the copy that is not moving", () => {
    const frozen = summary("t", 9, { moving: { to: "cloud", since: 1 } });
    const taken = summary("t", 9);
    expect(mergeThreadPages([mac([frozen]), cloud([taken])], {}, "mac")).toEqual([{ ...taken, owner: { brain: "cloud", reach: "live", heardAt: 4 } }]);
    expect(mergeThreadPages([cloud([taken]), mac([frozen])], {}, "mac")).toHaveLength(1);
  });

  it("pages trees by their newest member and keeps each tree whole", () => {
    const rows = [summary("parent", 1), summary("child", 50, { parentThreadId: "parent", parentRelation: "started" })];
    const merged = mergeThreadPages([mac(rows), cloud([summary("c", 40)])], { limit: 1, includeChildren: true, orderBy: "activity" }, "mac");
    expect(merged.map((row) => row.id)).toEqual(["child", "parent"]);
  });

  it("keeps the selected thread's tree beyond the page", () => {
    const merged = mergeThreadPages([mac([summary("new", 9)]), cloud([summary("old", 1)])], { limit: 1, selectedId: "old", includeChildren: true }, "mac");
    expect(merged.map((row) => row.id)).toEqual(["new", "old"]);
  });
});

describe("mergeInbox", () => {
  it("lists each waiting item once across hosts", () => {
    const item = { kind: "thread" as const, thread: summary("t", 1), runId: "r", reason: "approval" as const, detail: "Approve" };
    const inbox = (items: InboxList["items"]): { inbox: InboxList } => ({ inbox: { items } });
    expect(mergeInbox([inbox([item]), inbox([item, { ...item, runId: "r2" }])]).items.map((each) => each.runId)).toEqual(["r", "r2"]);
  });
});

describe("the Mac's session on the brain", () => {
  it("admits what the router forwards and nothing it serves itself or refuses", () => {
    expect(OWNER_SESSION_METHODS.has("events.page")).toBe(true);
    expect(OWNER_SESSION_METHODS.has("threads.list")).toBe(true);
    expect(OWNER_SESSION_METHODS.has("threads.fork")).toBe(false);
    expect(OWNER_SESSION_METHODS.has("instructions.list")).toBe(false);
    expect(OWNER_SESSION_METHODS.has("projects.list")).toBe(false);
    // Moves are the Mac's to coordinate; only the Mac's copy of a thread asks the brain for its code.
    expect(OWNER_SESSION_METHODS.has("cloud.bringToMac")).toBe(false);
    expect(OWNER_SESSION_METHODS.has("threads.snapshot")).toBe(true);
    expect(OWNER_SESSION_METHODS.has("threads.start")).toBe(true);
    expect(OWNER_SESSION_METHODS.has("attachments.save")).toBe(true);
  });
});

describe("where a row lives", () => {
  it("marks an OpenOrc Cloud row, dimmed while it is out of reach, and nothing on this Mac's own", () => {
    expect(ownerMark(summary("t", 1))).toBeNull();
    expect(ownerMark(summary("t", 1, { owner: { brain: "hosted", reach: "live", heardAt: 1 } }))).toEqual({ label: "OpenOrc Cloud", dim: false });
    expect(ownerMark(summary("t", 1, { owner: { brain: "hosted", reach: "offline", heardAt: 1 } }))).toEqual({ label: "OpenOrc Cloud", dim: true });
    expect(ownerMark(summary("t", 1, { owner: { brain: "mac", reach: "live", heardAt: 1 } }))).toBeNull();
  });
});
