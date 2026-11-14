import type { ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { sidebarGroupsGrow } from "./sidebar-days.js";
import { cloudProjects, inShownWorkspaces, liveGroupedFold, liveHiddenWorkspaces, projectGroups, threadFilterLabel, toggleWorkspace, waitingRoots, WORKSPACES_FOLD } from "./sidebar-groups.js";

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

  it("counts a question and a failure as waiting, never an unread result or work under way, and a parent once for its sub threads", () => {
    const roots = [
      thread("ask", "openorc", { activity: "waiting" }),
      thread("run", "openorc", { activity: "running" }),
      thread("read", "openorc", { unread: true }),
      thread("fail", "openorc", { session: { status: "error", message: null } }),
      thread("parent", "openorc"),
    ];
    const children = [thread("child", "openorc", { parentThreadId: "parent", activity: "waiting" }), thread("child-2", "openorc", { parentThreadId: "parent", unread: true })];
    expect(waitingRoots(roots, [...roots, ...children])).toBe(3);
    expect(projectGroups(projects, roots, roots)[0]!.waiting).toBe(2);
    const onlyUnreadBelow = [thread("child", "openorc", { parentThreadId: "parent", unread: true })];
    expect(waitingRoots([roots[4]!], [roots[4]!, ...onlyUnreadBelow])).toBe(0);
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

describe("cloudProjects", () => {
  it("names each project only OpenOrc Cloud has once, by name, whatever order its rows come in", () => {
    const row = (id: string, projectId: string, name?: string) =>
      ({ id, projectId, owner: name ? { brain: "hosted", reach: "live", heardAt: 0, project: { name } } : undefined }) as unknown as ThreadSummary;
    expect(cloudProjects([row("a", "openorc-cloud:web", "website"), row("b", "mac"), row("c", "openorc-cloud:web", "website"), row("d", "openorc-cloud:api", "api")])).toEqual([
      { id: "openorc-cloud:api", name: "api", cloud: true },
      { id: "openorc-cloud:web", name: "website", cloud: true },
    ]);
  });
});

describe("the workspace filter", () => {
  it("an unticked workspace's threads leave the list and every other workspace's stay", () => {
    const rows = [thread("a", "openorc"), thread("b", "immaculate"), thread("c", "openorc")];
    expect(inShownWorkspaces(rows, ["openorc"]).map((t) => t.id)).toEqual(["b"]);
    expect(inShownWorkspaces(rows, []).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("stores what is hidden, so a workspace added later shows by itself", () => {
    let hidden = toggleWorkspace([], "openorc");
    expect(hidden).toEqual(["openorc"]);
    const later = [thread("a", "openorc"), thread("n", "new-project")];
    expect(inShownWorkspaces(later, hidden).map((t) => t.id)).toEqual(["n"]);
    hidden = toggleWorkspace(hidden, "openorc");
    expect(hidden).toEqual([]);
  });

  it("forgets a hidden workspace that no longer exists", () => {
    expect(liveHiddenWorkspaces(["openorc", "removed"], ["openorc", "immaculate"])).toEqual(["openorc"]);
  });

  it("the filter's name says the pinned filter and how many workspaces are hidden", () => {
    expect(threadFilterLabel({ pinnedOnly: false, hidden: 0 })).toBe("Filter threads");
    expect(threadFilterLabel({ pinnedOnly: false, hidden: 1 })).toBe("Filter threads: 1 workspace hidden");
    expect(threadFilterLabel({ pinnedOnly: true, hidden: 2 })).toBe("Filter threads: Pinned threads, 2 workspaces hidden");
    expect(threadFilterLabel({ pinnedOnly: true, hidden: 0 })).toBe("Filter threads: Pinned threads");
  });
});
