import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "@openorc/protocol";
import { ORC_MODE_WINDOW, sidebarThreadPage, visibleSidebarThreadIds } from "./sidebar-thread-groups";

function thread(id: string, values: Partial<ThreadSummary> = {}): ThreadSummary {
  return { id, projectId: "project", archivedAt: null, pinnedAt: null, snoozedUntil: null, ...values } as ThreadSummary;
}

describe("sidebar thread page", () => {
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
