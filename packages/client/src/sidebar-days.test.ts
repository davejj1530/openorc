import type { ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { liveSidebarFold, RECENT_MS, sidebarDay, sidebarDayKey, sidebarDayList, sidebarDayOpen, sidebarDaySections, sidebarListGrows } from "./sidebar-days.js";
import { sidebarThreadPage, toggleSidebarFold } from "./sidebar-thread-groups.js";

const now = new Date(2026, 10, 6, 20, 0).getTime();
const at = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime();

function thread(id: string, lastActivityAt: number, values: Partial<ThreadSummary> = {}): ThreadSummary {
  return { id, projectId: "project", lastActivityAt, archivedAt: null, pinnedAt: null, snoozedUntil: null, activity: "idle", unread: false, ...values } as ThreadSummary;
}

describe("sidebar days", () => {
  it("keeps the last three hours together on top, then groups by local calendar day", () => {
    expect(sidebarDay(now - 1000, now)).toBe("recent");
    expect(sidebarDay(now - RECENT_MS, now)).toBe("recent");
    expect(sidebarDay(now - RECENT_MS - 1, now)).toBe("today");
    // Just past midnight, last night's work is recent, not yesterday's.
    expect(sidebarDay(at(5, 23), at(6, 1))).toBe("recent");
    expect(sidebarDay(at(6, 0), now)).toBe("today");
    expect(sidebarDay(at(5, 23), now)).toBe("yesterday");
    expect(sidebarDay(at(5, 0), now)).toBe("yesterday");
    expect(sidebarDay(at(4, 23), now)).toBe("week");
    expect(sidebarDay(at(0, 0), now)).toBe("week");
    expect(sidebarDay(at(-1, 23), now)).toBe("older");
  });

  it("opens recent and today at first, folds the rest, and saves only the reader's change", () => {
    expect((["recent", "today", "yesterday", "week", "older"] as const).map((day) => sidebarDayOpen([], day))).toEqual([true, true, false, false, false]);
    const saved = toggleSidebarFold(toggleSidebarFold([], sidebarDayKey("today")), sidebarDayKey("yesterday"));
    expect(sidebarDayOpen(saved, "today")).toBe(false);
    expect(sidebarDayOpen(saved, "yesterday")).toBe(true);
    expect(sidebarDayOpen(saved, "recent")).toBe(true);
  });

  it("files a parent by its family's latest work and keeps the given order", () => {
    const parent = thread("parent", at(1));
    const child = thread("child", now - 1000, { parentThreadId: "parent", parentRelation: "subagent" });
    const sections = sidebarDaySections([thread("a", at(6)), parent, thread("b", at(5)), thread("c", at(1))], [parent, child], now);
    expect(sections.map((section) => [section.day, section.roots.map((root) => root.id)])).toEqual([
      ["recent", ["parent"]],
      ["today", ["a"]],
      ["yesterday", ["b"]],
      ["week", ["c"]],
    ]);
  });

  it("keeps Older standing while more threads are left to load", () => {
    expect(sidebarDaySections([thread("a", at(6))], [], now, true).map((section) => [section.day, section.roots.length])).toEqual([
      ["today", 1],
      ["older", 0],
    ]);
  });

  it("reads further pages until an open day is complete, then waits for the reader inside Older", () => {
    const grows = (roots: ThreadSummary[], collapsed: string[] = [], hasMore = true) => {
      const last = roots.at(-1);
      return sidebarListGrows({ end: last ? sidebarDay(last.lastActivityAt, now) : null, hasMore, collapsed });
    };
    const recent = thread("recent", now - 1000);
    expect(grows([recent, thread("b", at(6))])).toBe(true);
    expect(grows([recent, thread("b", at(6))], [], false)).toBe(false);
    expect(grows([recent, thread("b", at(6))], [sidebarDayKey("today")])).toBe(false);
    expect(grows([thread("a", at(6)), thread("b", at(5))])).toBe(false);
    expect(grows([thread("a", at(6)), thread("b", at(5))], [sidebarDayKey("yesterday")])).toBe(true);
    expect(grows([thread("a", at(6)), thread("b", at(3))], [sidebarDayKey("week")])).toBe(true);
    expect(grows([thread("a", at(6)), thread("b", at(3))], [sidebarDayKey("older")])).toBe(true);
    expect(grows([thread("a", at(6)), thread("b", at(-2))], [sidebarDayKey("older")])).toBe(false);
    expect(grows([])).toBe(true);
  });

  it("keeps the threads that need you in a folded day, and the open thread, but not the rest", () => {
    const page = (fetched: ThreadSummary[], limit = 12) => sidebarThreadPage({ projectId: "project", fetched, selected: null, filter: "active", limit, now });
    const fetched = [
      thread("today", at(6)),
      thread("waiting", at(3), { activity: "waiting" }),
      thread("unread", at(2), { unread: true }),
      thread("open", at(2)),
      thread("quiet", at(2)),
      thread("parent", at(1)),
      thread("working child", at(1), { parentThreadId: "parent", parentRelation: "subagent", activity: "running" }),
      // A finished subagent is never opened, so its unread mark says nothing about its parent.
      thread("helped", at(1)),
      thread("done child", at(1), { parentThreadId: "helped", parentRelation: "subagent", unread: true }),
    ];
    const list = sidebarDayList({ pages: [page(fetched)], pinnedOnly: false, activeId: "open", now });
    const week = list.sections.find((section) => section.day === "week")!;
    expect(list.shownInDay(week.roots, false).map((root) => root.id)).toEqual(["waiting", "unread", "open", "parent"]);
    expect(list.shownInDay(week.roots, true).map((root) => root.id)).toEqual(["waiting", "unread", "quiet", "open", "parent", "helped"]);
    // Pinned and Snoozed fold behind their counts, keeping only the open thread.
    expect(list.shown(week.roots, false).map((root) => root.id)).toEqual(["open"]);
  });

  it("adds the threads that need you from past the loaded pages to their days, without letting them stop the list reading on", () => {
    const page = (fetched: ThreadSummary[], limit: number) => sidebarThreadPage({ projectId: "project", fetched, selected: null, filter: "active", limit, now });
    const loaded = page([thread("today", at(6)), thread("yesterday", at(5)), thread("more", at(5, 1))], 2);
    // An older host ignores the filter and answers with every thread, so only those that need you count.
    const needsYou = page([thread("yesterday", at(5), { unread: true }), thread("stale", at(-20)), thread("old unread", at(-20), { unread: true })], 50);
    const list = sidebarDayList({ pages: [loaded], needsYou, pinnedOnly: false, activeId: null, now });
    expect(list.sections.map((section) => [section.day, section.roots.map((root) => root.id)])).toEqual([
      ["today", ["today"]],
      ["yesterday", ["yesterday"]],
      ["older", ["old unread"]],
    ]);
    expect(list.all.find((row) => row.id === "yesterday")?.unread).toBe(false);
    expect(list.end).toBe("yesterday");
    expect(sidebarListGrows({ end: list.end, hasMore: list.hasMore, collapsed: [sidebarDayKey("yesterday")] })).toBe(true);
    expect(sidebarDayList({ pages: [loaded], needsYou, pinnedOnly: true, activeId: null, now }).rest).toEqual([]);
  });

  it("keeps the saved folds the list still has and drops the project groups and folds a day now starts with", () => {
    const saved = ["snoozed", "project:one", "pinned:one", "snoozed-open:one", "pinned:threads", "snoozed-open:threads", "thread-closed:a", "thread-open:b", "day-closed:today", "day-open:older"];
    expect(saved.filter(liveSidebarFold)).toEqual(["pinned:threads", "snoozed-open:threads", "thread-closed:a", "thread-open:b", "day-closed:today", "day-open:older"]);
    // Yesterday used to start open, so folding it saved a key; it starts folded now.
    expect(["day-closed:yesterday", "day-open:today", "day-closed:recent", "day-open:yesterday"].filter(liveSidebarFold)).toEqual(["day-closed:recent", "day-open:yesterday"]);
  });
});
