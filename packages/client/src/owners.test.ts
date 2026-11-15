import { mergeThreadPages, type HostPage, type ThreadSummary } from "@openorc/protocol";
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
const cloud = (rows: ThreadSummary[], reach: HostPage["reach"] = "live"): HostPage => ({ brain: "hosted", reach, heardAt: 4, rows });

describe("mergeThreadPages", () => {
  it("interleaves both places by activity and keeps the merged top of the page", () => {
    const merged = mergeThreadPages([mac([summary("m3", 30), summary("m1", 10)]), cloud([summary("c4", 40), summary("c2", 20)])], { limit: 3 }, "mac");
    expect(merged.map((row) => row.id)).toEqual(["c4", "m3", "c2"]);
  });

  it("marks only rows from another place, with whether it can be reached", () => {
    const merged = mergeThreadPages([mac([summary("m", 2)]), cloud([summary("c", 1)], "offline")], {}, "mac");
    expect(merged.map((row) => row.owner ?? null)).toEqual([null, { brain: "hosted", reach: "offline", heardAt: 4 }]);
    expect(mergeThreadPages([mac([summary("m", 2)])], {}, null)[0]?.owner).toEqual({ brain: "mac", reach: "live", heardAt: 5 });
  });

  it("lists a thread two places name once, the first one's", () => {
    const here = summary("t", 9, { title: "here" });
    expect(mergeThreadPages([mac([here]), cloud([summary("t", 9, { title: "there" })])], {}, "mac")).toEqual([here]);
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

describe("where a row lives", () => {
  it("marks an OpenOrc Cloud row, dimmed while it is out of reach, and nothing on this Mac's own", () => {
    expect(ownerMark(summary("t", 1))).toBeNull();
    expect(ownerMark(summary("t", 1, { owner: { brain: "hosted", reach: "live", heardAt: 1 } }))).toEqual({ label: "OpenOrc Cloud", dim: false });
    expect(ownerMark(summary("t", 1, { owner: { brain: "hosted", reach: "offline", heardAt: 1 } }))).toEqual({ label: "OpenOrc Cloud", dim: true });
    expect(ownerMark(summary("t", 1, { owner: { brain: "mac", reach: "live", heardAt: 1 } }))).toBeNull();
  });
});
