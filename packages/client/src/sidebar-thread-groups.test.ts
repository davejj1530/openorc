import type { ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { ORC_MODE_WINDOW, projectMeta, sidebarSectionOpen, sidebarThreadPage, threadListParams, toggleSidebarFold, visibleSidebarThreadIds } from "./sidebar-thread-groups.js";
import { threadTreeRows, toggleThreadTree } from "./thread-tree.js";

function thread(id: string, values: Partial<ThreadSummary> = {}): ThreadSummary {
  return { id, projectId: "project", archivedAt: null, pinnedAt: null, snoozedUntil: null, ...values } as ThreadSummary;
}

describe("sidebar thread page", () => {
  it("counts full conversations while excluding native children", () => {
    expect(
      projectMeta([thread("root", { activity: "idle" }), thread("started", { activity: "idle", parentRelation: "started" }), thread("native", { activity: "idle", parentRelation: "subagent" })], {
        loaded: true,
      }),
    ).toEqual({ text: "2 threads", tone: "faint" });
  });
  it("shows a started child as a root when its parent is hidden, archived or in a different pin/snooze section", () => {
    const parent = thread("parent", { archivedAt: 1 });
    const child = thread("child", { parentThreadId: parent.id, parentRelation: "started", pinnedAt: 2 });
    const nested = thread("nested", { parentThreadId: child.id, parentRelation: "subagent" });
    const page = (fetched: ThreadSummary[], hidden?: Set<string>) => sidebarThreadPage({ projectId: "project", fetched, hidden, selected: child, filter: "active", limit: 12, now: 100 });
    expect(page([child, nested]).pinned.map((t) => t.id)).toEqual(["child"]);
    expect(page([{ ...parent, archivedAt: null }, child, nested], new Set(["parent"])).list.map((t) => t.id)).toEqual(["child", "nested"]);
    expect(page([{ ...parent, archivedAt: null }, child, nested]).pinned.map((t) => t.id)).toEqual(["child"]);
    expect(page([{ ...parent, archivedAt: null }, { ...child, pinnedAt: null, snoozedUntil: 200 }, nested]).snoozed.map((t) => t.id)).toEqual(["child"]);
  });
  it("omits retired conversations from cached pages and selected rows", () => {
    const retired = thread("retired", { teamInstanceId: "saved" });
    const current = thread("current");
    const page = sidebarThreadPage({ projectId: "project", fetched: [retired, current], selected: retired, filter: "active", limit: 1, now: 100 });
    expect(page.list).toEqual([current]);
  });
  it("keeps a selected thread outside the fetched page without changing pagination", () => {
    const fetched = [thread("first"), thread("lookahead")];
    const selected = thread("selected");
    const page = sidebarThreadPage({ projectId: "project", fetched, selected, filter: "active", limit: 1, now: 100 });
    expect(page.list.map((row) => row.id)).toEqual(["first", "selected"]);
    expect(page.hasMore).toBe(true);
    expect(fetched.map((row) => row.id)).toEqual(["first", "lookahead"]);
    expect(sidebarThreadPage({ projectId: "other", fetched, selected, filter: "active", limit: 1, now: 100 }).list.map((row) => row.id)).toEqual(["first"]);
    expect(sidebarThreadPage({ projectId: "project", fetched, selected: thread("archived", { archivedAt: 1 }), filter: "active", limit: 1, now: 100 }).list.map((row) => row.id)).toEqual(["first"]);
  });

  it("puts active snoozed threads ahead of pinned status and exposes only expanded rows to keyboard order", () => {
    const page = sidebarThreadPage({
      projectId: "project",
      fetched: [thread("pinned", { pinnedAt: 1 }), thread("both", { pinnedAt: 1, snoozedUntil: 200 }), thread("regular"), thread("snoozed", { snoozedUntil: 200 })],
      selected: null,
      filter: "active",
      limit: 8,
      now: 100,
    });
    expect(page.pinned.map((row) => row.id)).toEqual(["pinned"]);
    expect(page.rest.map((row) => row.id)).toEqual(["regular"]);
    expect(page.snoozed.map((row) => row.id)).toEqual(["both", "snoozed"]);
    const section = [{ id: "project", ...page }];
    expect(visibleSidebarThreadIds(section, [])).toEqual(["pinned", "regular"]);
    expect(visibleSidebarThreadIds(section, ["snoozed-open:project"])).toEqual(["pinned", "regular", "both", "snoozed"]);
    expect(visibleSidebarThreadIds(section, ["pinned:project", "snoozed-open:project"])).toEqual(["regular", "both", "snoozed"]);
    expect(visibleSidebarThreadIds(section, ["project:project"])).toEqual([]);
  });

  it("keeps orcmode's working set and the open thread, and counts what it leaves out", () => {
    const now = 10 * ORC_MODE_WINDOW;
    const old = now - 2 * ORC_MODE_WINDOW;
    const idle = { activity: "idle", unread: false, lastActivityAt: old } as const;
    const fetched = [
      thread("waiting", { ...idle, activity: "waiting" }),
      thread("running", { ...idle, activity: "running" }),
      thread("unread", { ...idle, unread: true }),
      thread("pinned", { ...idle, pinnedAt: 1 }),
      thread("recent", { ...idle, lastActivityAt: now - ORC_MODE_WINDOW + 1 }),
      thread("stale", idle),
      thread("snoozed", { ...idle, lastActivityAt: now, snoozedUntil: now + 1 }),
    ];
    const page = sidebarThreadPage({ projectId: "project", fetched, selected: thread("open", idle), filter: "orc", limit: 8, now });
    expect(page.pinned.map((row) => row.id)).toEqual(["pinned"]);
    expect(page.rest.map((row) => row.id)).toEqual(["waiting", "running", "unread", "recent", "open"]);
    expect(page.snoozed).toEqual([]);
    expect(page.leftOut).toBe(2);
    expect(sidebarThreadPage({ projectId: "project", fetched, selected: null, filter: "active", limit: 8, now }).leftOut).toBe(0);
  });

  it("leaves archived threads in fetched order without active-only groups", () => {
    const page = sidebarThreadPage({ projectId: "project", fetched: [thread("pinned", { archivedAt: 1, pinnedAt: 1, snoozedUntil: 200 })], selected: null, filter: "archived", limit: 8, now: 100 });
    expect(page.pinned).toEqual([]);
    expect(page.snoozed).toEqual([]);
    expect(page.rest.map((row) => row.id)).toEqual(["pinned"]);
  });
});

describe("sidebar folds", () => {
  it("reveals a selected child but lets a subsequent manual fold win", () => {
    const parent = thread("parent", { activity: "idle" });
    const child = thread("child", { parentThreadId: "parent", parentRelation: "subagent", activity: "idle" });
    const nested = thread("nested", { parentThreadId: "child", parentRelation: "subagent", activity: "idle" });
    expect(threadTreeRows([parent], [parent, child, nested], [], ["nested"]).map((r) => r.thread.id)).toEqual(["parent", "child", "nested"]);
    expect(threadTreeRows([parent], [parent, child, nested], ["thread-closed:parent"], ["nested"]).map((r) => r.thread.id)).toEqual(["parent"]);
  });
  it("pages parents, nests both kinds of child, and respects manual folds across status changes", () => {
    const parent = thread("parent", { activity: "idle", createdAt: 1, lastActivityAt: 1 });
    const child = thread("child", { parentThreadId: "parent", parentRelation: "subagent", activity: "running", createdAt: 2, lastActivityAt: 10 });
    const started = thread("started", { parentThreadId: "parent", parentRelation: "started", activity: "idle", createdAt: 3, lastActivityAt: 2 });
    const nested = thread("nested", { parentThreadId: "child", parentRelation: "subagent", activity: "running", createdAt: 4, lastActivityAt: 11 });
    const fetched = [thread("other", { lastActivityAt: 5 }), child, nested, started, parent];
    const page = sidebarThreadPage({ projectId: "project", fetched, selected: null, filter: "active", limit: 1, now: 20 });
    expect(page.rest.map((row) => row.id)).toEqual(["parent"]);
    expect(page.hasMore).toBe(true);
    const section = [{ id: "project", ...page }];
    expect(visibleSidebarThreadIds(section, [])).toEqual(["parent", "child", "nested", "started"]);
    expect(threadTreeRows(page.rest, page.list, []).map((row) => row.depth)).toEqual([0, 1, 2, 1]);
    const closed = toggleThreadTree([], "parent", true);
    expect(visibleSidebarThreadIds(section, closed)).toEqual(["parent"]);
    const finished = page.list.map((row) => ({ ...row, activity: "idle" as const }));
    expect(threadTreeRows(page.rest, finished, []).map((row) => row.thread.id)).toEqual(["parent"]);
    expect(threadTreeRows(page.rest, finished, toggleThreadTree(closed, "parent", false)).map((row) => row.thread.id)).toEqual(["parent", "child", "started"]);
  });
  it("lists projects and pins until folded, and snoozed threads once opened", () => {
    expect([sidebarSectionOpen([], "project", "p"), sidebarSectionOpen([], "pinned", "p"), sidebarSectionOpen([], "snoozed", "p")]).toEqual([true, true, false]);
    const saved = ["project:p", "pinned:p", "snoozed-open:p"];
    expect([sidebarSectionOpen(saved, "project", "p"), sidebarSectionOpen(saved, "pinned", "p"), sidebarSectionOpen(saved, "snoozed", "p")]).toEqual([false, false, true]);
    expect(sidebarSectionOpen(saved, "project", "other")).toBe(true);
  });

  it("folds and opens a section by its key, leaving the others", () => {
    expect(toggleSidebarFold(["pinned:a"], "project:b")).toEqual(["pinned:a", "project:b"]);
    expect(toggleSidebarFold(["pinned:a", "project:b"], "project:b")).toEqual(["pinned:a"]);
  });
});

describe("project heading meta", () => {
  const idle = { activity: "idle" } as const;
  const running = { activity: "running" } as const;
  const waiting = { activity: "waiting" } as const;
  it("puts a waiting thread first, then running threads, then the count", () => {
    expect(projectMeta([idle, running, waiting], { loaded: true })).toEqual({ text: "Needs you", tone: "attention" });
    expect(projectMeta([idle, running, running], { loaded: true })).toEqual({ text: "2 running", tone: "faint" });
    expect(projectMeta([idle], { loaded: true })).toEqual({ text: "1 thread", tone: "faint" });
    expect(projectMeta([idle, idle], { loaded: true, more: true })).toEqual({ text: "2+ threads", tone: "faint" });
    expect(projectMeta([], { loaded: true })).toEqual({ text: "No threads", tone: "faint" });
  });
  it("says nothing about counts while the list loads", () => {
    expect(projectMeta([], { loaded: false })).toBeNull();
    expect(projectMeta([running], { loaded: false })).toEqual({ text: "1 running", tone: "faint" });
  });
});

describe("thread list reads", () => {
  it("asks for one more thread than a project shows, from the list its filter reads", () => {
    expect(threadListParams("project", "orc")).toEqual({ projectId: "project", filter: "active", limit: 13, includeChildren: true });
    expect(threadListParams("project", "archived", 24)).toEqual({ projectId: "project", filter: "archived", limit: 25, includeChildren: true });
  });
});
