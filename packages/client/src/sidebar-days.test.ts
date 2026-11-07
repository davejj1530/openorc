import type { ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { liveSidebarFold, RECENT_MS, resolvedRows, sidebarDayKey, sidebarDayList, sidebarDayOpen, sidebarDaySections, sidebarListGrows, sidebarPlace, threadResolved } from "./sidebar-days.js";
import { sidebarFoldKey, sidebarThreadPage, toggleSidebarFold } from "./sidebar-thread-groups.js";

const now = new Date(2026, 10, 6, 20, 0).getTime();
const at = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime();

function thread(id: string, lastActivityAt: number, values: Partial<ThreadSummary> = {}): ThreadSummary {
  return { id, projectId: "project", lastActivityAt, archivedAt: null, pinnedAt: null, snoozedUntil: null, activity: "idle", unread: false, ...values } as ThreadSummary;
}

describe("sidebar days", () => {
  it("keeps the last three hours together on top, then today and yesterday by local calendar day, and resolves what is older", () => {
    expect(sidebarPlace(now - 1000, now)).toBe("recent");
    expect(sidebarPlace(now - RECENT_MS, now)).toBe("recent");
    expect(sidebarPlace(now - RECENT_MS - 1, now)).toBe("today");
    // Just past midnight, last night's work is recent, not yesterday's.
    expect(sidebarPlace(at(5, 23), at(6, 1))).toBe("recent");
    expect(sidebarPlace(at(6, 0), now)).toBe("today");
    expect(sidebarPlace(at(5, 23), now)).toBe("yesterday");
    expect(sidebarPlace(at(5, 0), now)).toBe("yesterday");
    expect(sidebarPlace(at(4, 23), now)).toBe("resolved");
    expect(sidebarPlace(at(-1, 23), now)).toBe("resolved");
  });

  it("opens recent and today at first, folds the rest, and saves only the reader's change", () => {
    expect((["recent", "today", "yesterday"] as const).map((day) => sidebarDayOpen([], day))).toEqual([true, true, false]);
    const saved = toggleSidebarFold(toggleSidebarFold([], sidebarDayKey("today")), sidebarDayKey("yesterday"));
    expect(sidebarDayOpen(saved, "today")).toBe(false);
    expect(sidebarDayOpen(saved, "yesterday")).toBe(true);
    expect(sidebarDayOpen(saved, "recent")).toBe(true);
  });

  it("files a parent by its family's latest work, keeps the given order, and leaves resolved ones out", () => {
    const parent = thread("parent", at(1));
    const child = thread("child", now - 1000, { parentThreadId: "parent", parentRelation: "subagent" });
    const sections = sidebarDaySections([thread("a", at(6)), parent, thread("b", at(5)), thread("quiet", at(4))], [parent, child], now);
    expect(sections.map((section) => [section.day, section.roots.map((root) => root.id)])).toEqual([
      ["recent", ["parent"]],
      ["today", ["a"]],
      ["yesterday", ["b"]],
    ]);
  });

  it("calls a thread resolved when put there, or quiet since before yesterday with no pin or snooze keeping it out", () => {
    expect(threadResolved(thread("put", now, { archivedAt: now }), now)).toBe(true);
    expect(threadResolved(thread("quiet", at(4, 23)), now)).toBe(true);
    expect(threadResolved(thread("yesterday", at(5, 0)), now)).toBe(false);
    expect(threadResolved(thread("quiet family", at(-3), { treeActivityAt: now }), now)).toBe(false);
    expect(threadResolved(thread("pinned", at(-3), { pinnedAt: 1 }), now)).toBe(false);
    expect(threadResolved(thread("snoozed", at(-3), { snoozedUntil: now + 1000 }), now)).toBe(false);
  });

  it("reads further pages until an open day is complete, then waits for the reader inside Resolved", () => {
    const grows = (roots: ThreadSummary[], collapsed: string[] = [], hasMore = true) => {
      const last = roots.at(-1);
      return sidebarListGrows({ end: last ? sidebarPlace(last.lastActivityAt, now) : null, hasMore, collapsed });
    };
    const resolvedOpen = sidebarFoldKey.resolved("threads");
    const recent = thread("recent", now - 1000);
    expect(grows([recent, thread("b", at(6))])).toBe(true);
    expect(grows([recent, thread("b", at(6))], [], false)).toBe(false);
    expect(grows([recent, thread("b", at(6))], [sidebarDayKey("today")])).toBe(false);
    expect(grows([thread("a", at(6)), thread("b", at(5))])).toBe(false);
    expect(grows([thread("a", at(6)), thread("b", at(5))], [sidebarDayKey("yesterday")])).toBe(true);
    expect(grows([thread("a", at(6)), thread("b", at(6, 1))], [sidebarDayKey("today"), resolvedOpen])).toBe(true);
    expect(grows([thread("a", at(6)), thread("b", at(3))], [resolvedOpen])).toBe(false);
    expect(grows([])).toBe(true);
  });

  it("keeps the threads that need you in a folded day, and the open thread, but not the rest", () => {
    const page = (fetched: ThreadSummary[], limit = 12) => sidebarThreadPage({ projectId: "project", fetched, selected: null, filter: "active", limit, now });
    const fetched = [
      thread("today", at(6)),
      thread("waiting", at(5, 16), { activity: "waiting" }),
      thread("unread", at(5, 14), { unread: true }),
      thread("open", at(5, 14)),
      thread("quiet", at(5, 14)),
      thread("parent", at(5, 10)),
      thread("working child", at(5, 10), { parentThreadId: "parent", parentRelation: "subagent", activity: "running" }),
      // A finished subagent is never opened, so its unread mark says nothing about its parent.
      thread("helped", at(5, 10)),
      thread("done child", at(5, 10), { parentThreadId: "helped", parentRelation: "subagent", unread: true }),
    ];
    const list = sidebarDayList({ pages: [page(fetched)], pinnedOnly: false, activeId: "open", now });
    const yesterday = list.sections.find((section) => section.day === "yesterday")!;
    expect(list.shownInDay(yesterday.roots, false).map((root) => root.id)).toEqual(["waiting", "unread", "open", "parent"]);
    expect(list.shownInDay(yesterday.roots, true).map((root) => root.id)).toEqual(["waiting", "unread", "quiet", "open", "parent", "helped"]);
    // Pinned, Snoozed and Resolved fold to their headings, keeping only the open thread.
    expect(list.shown(yesterday.roots, false).map((root) => root.id)).toEqual(["open"]);
  });

  it("adds the threads that need you from past the loaded pages to their days, without letting them stop the list reading on", () => {
    const page = (fetched: ThreadSummary[], limit: number) => sidebarThreadPage({ projectId: "project", fetched, selected: null, filter: "active", limit, now });
    const loaded = page([thread("today", at(6)), thread("yesterday", at(5)), thread("more", at(5, 1))], 2);
    // An older host ignores the filter and answers with every thread, so only those that need you count.
    const needsYou = page([thread("yesterday", at(5), { unread: true }), thread("stale", at(-20)), thread("old unread", at(-20), { unread: true })], 50);
    const list = sidebarDayList({ pages: [loaded], needsYou, pinnedOnly: false, activeId: null, now });
    // The old unread thread is resolved by its age, and lies past where the loaded pages are whole.
    expect(list.sections.map((section) => [section.day, section.roots.map((root) => root.id)])).toEqual([
      ["today", ["today"]],
      ["yesterday", ["yesterday"]],
    ]);
    expect(list.resolved).toEqual({ roots: [], hasMore: true });
    expect(list.all.find((row) => row.id === "yesterday")?.unread).toBe(false);
    expect(list.end).toBe("yesterday");
    expect(sidebarListGrows({ end: list.end, hasMore: list.hasMore, collapsed: [sidebarDayKey("yesterday")] })).toBe(true);
    expect(sidebarDayList({ pages: [loaded], needsYou, pinnedOnly: true, activeId: null, now }).rest).toEqual([]);
  });

  it("merges the threads put in Resolved with the quiet ones, newest work first, as far as both reads are whole", () => {
    const page = (fetched: ThreadSummary[], limit: number, filter: "active" | "archived" = "active") => sidebarThreadPage({ projectId: "project", fetched, selected: null, filter, limit, now });
    const active = [thread("today", at(6)), thread("quiet", at(-2)), thread("quieter", at(-10)), thread("unread", at(-30))];
    const put = [thread("put", at(5), { archivedAt: now }), thread("put earlier", at(-5), { archivedAt: now }), thread("put long ago", at(-20), { archivedAt: now })];
    const listed = page(active, 3);
    const resolved = page(put, 2, "archived");
    const ids = (activeId: string | null) => sidebarDayList({ pages: [listed], resolved, pinnedOnly: false, activeId, now }).resolved.roots.map((root) => root.id);
    // The list reads on past "quieter", and the put read past "put earlier", so neither may yet hold what lies between.
    expect(ids(null)).toEqual(["put", "quiet", "put earlier"]);
    expect(ids("quieter")).toEqual(["put", "quiet", "put earlier", "quieter"]);
    const whole = sidebarDayList({ pages: [page(active, 12)], resolved: page(put, 12, "archived"), pinnedOnly: false, activeId: null, now });
    expect(whole.resolved).toMatchObject({ hasMore: false });
    expect(whole.resolved.roots.map((root) => root.id)).toEqual(["put", "quiet", "put earlier", "quieter", "put long ago", "unread"]);
    expect(whole.sections.map((section) => section.day)).toEqual(["today"]);
    expect(sidebarDayList({ pages: [listed], resolved, pinnedOnly: true, activeId: null, now }).resolved).toEqual({ roots: [], hasMore: false });
  });

  it("pages Resolved from its read while open, and folded holds no more than the open thread when that one was put there", () => {
    const read = [thread("put", at(5), { archivedAt: now })];
    expect(resolvedRows(true, read, null)).toBe(read);
    expect(resolvedRows(false, read, thread("open", now))).toBeUndefined();
    expect(resolvedRows(false, read, thread("open", now, { archivedAt: now }))).toEqual([]);
    // Still reading, it holds the open thread as it would folded.
    expect(resolvedRows(true, undefined, thread("open", now, { archivedAt: now }))).toEqual([]);
  });

  it("keeps the saved folds the list still has and drops the project groups and folds a day now starts with", () => {
    const saved = [
      "snoozed",
      "project:one",
      "pinned:one",
      "snoozed-open:one",
      "pinned:threads",
      "snoozed-open:threads",
      "resolved-open:threads",
      "thread-closed:a",
      "thread-open:b",
      "day-closed:today",
      "day-open:older",
    ];
    expect(saved.filter(liveSidebarFold)).toEqual(["pinned:threads", "snoozed-open:threads", "resolved-open:threads", "thread-closed:a", "thread-open:b", "day-closed:today"]);
    // Yesterday used to start open, so folding it saved a key; it starts folded now.
    expect(["day-closed:yesterday", "day-open:today", "day-closed:recent", "day-open:yesterday"].filter(liveSidebarFold)).toEqual(["day-closed:recent", "day-open:yesterday"]);
  });
});
