import type { ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { sidebarGroupsGrow } from "./sidebar-days.js";
import { groupPage, liveGroupedFold, projectGroups, waitingRoots, WORKSPACES_FOLD } from "./sidebar-groups.js";

function thread(id: string, projectId: string, values: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id,
    projectId,
    parentThreadId: null,
    lastActivityAt: 1,
    archivedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    activity: "idle",
    unread: false,
    session: { status: "idle", message: null },
    ...values,
  } as ThreadSummary;
}

const projects = [
  { id: "openorc", name: "openorc" },
  { id: "site", name: "website" },
  { id: "empty", name: "immaculate" },
];

describe("sidebar project groups", () => {
  it("groups roots under their projects in the projects' order, keeps empty projects, and drops unknown ones", () => {
    const roots = [thread("a", "site"), thread("b", "openorc"), thread("c", "gone"), thread("d", "site")];
    const groups = projectGroups(projects, roots, roots);
    expect(groups.map((group) => [group.project.id, group.roots.map((root) => root.id)])).toEqual([
      ["openorc", ["b"]],
      ["site", ["a", "d"]],
      ["empty", []],
    ]);
  });

  it("counts a question, a failure and an unread result as waiting, never work under way, and a parent once for its sub threads", () => {
    const roots = [
      thread("ask", "openorc", { activity: "waiting" }),
      thread("run", "openorc", { activity: "running" }),
      thread("read", "openorc", { unread: true }),
      thread("fail", "openorc", { session: { status: "error", message: null } }),
      thread("parent", "openorc"),
    ];
    const children = [thread("child", "openorc", { parentThreadId: "parent", activity: "waiting" }), thread("child-2", "openorc", { parentThreadId: "parent", unread: true })];
    expect(waitingRoots(roots, [...roots, ...children])).toBe(4);
    expect(projectGroups(projects, roots, roots)[0]!.waiting).toBe(3);
  });

  it("pages a group, keeps the open thread past the page, and folded lists only the open thread's tree", () => {
    const roots = Array.from({ length: 7 }, (_, index) => thread(`t${index}`, "openorc"));
    const holdsActive = (root: ThreadSummary) => root.id === "t6";
    expect(groupPage(roots, { open: true, shown: 4, holdsActive: () => false })).toMatchObject({ hidden: 3 });
    const kept = groupPage(roots, { open: true, shown: 4, holdsActive });
    expect(kept.rows.map((row) => row.id)).toEqual(["t0", "t1", "t2", "t3", "t6"]);
    expect(kept.hidden).toBe(2);
    expect(groupPage(roots, { open: false, shown: 4, holdsActive }).rows.map((row) => row.id)).toEqual(["t6"]);
  });

  it("reads on until the loaded threads reach Resolved, then waits to be asked", () => {
    expect(sidebarGroupsGrow({ end: "yesterday", hasMore: true, limit: 12 })).toBe(true);
    expect(sidebarGroupsGrow({ end: null, hasMore: true, limit: 12 })).toBe(true);
    expect(sidebarGroupsGrow({ end: "resolved", hasMore: true, limit: 12 })).toBe(false);
    expect(sidebarGroupsGrow({ end: "today", hasMore: false, limit: 12 })).toBe(false);
    expect(sidebarGroupsGrow({ end: "today", hasMore: true, limit: 400 })).toBe(false);
  });

  it("keeps the folds the grouped list has across launches, a project's and Workspaces' among them, and drops the days'", () => {
    expect(liveGroupedFold("project:openorc")).toBe(true);
    expect(liveGroupedFold(WORKSPACES_FOLD)).toBe(true);
    expect(liveGroupedFold("thread-closed:a")).toBe(true);
    expect(liveGroupedFold("resolved-open:threads")).toBe(true);
    expect(liveGroupedFold("day-closed:recent")).toBe(false);
    expect(liveGroupedFold("projects:openorc")).toBe(false);
  });
});
