import type { ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { liveSidebarFold, sidebarDay, sidebarDayKey, sidebarDayOpen, sidebarDaySections, sidebarListGrows } from "./sidebar-days.js";
import { toggleSidebarFold } from "./sidebar-thread-groups.js";

const now = new Date(2026, 10, 6, 1, 30).getTime();
const at = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime();

function thread(id: string, lastActivityAt: number, values: Partial<ThreadSummary> = {}): ThreadSummary {
  return { id, projectId: "project", lastActivityAt, archivedAt: null, pinnedAt: null, snoozedUntil: null, ...values } as ThreadSummary;
}

describe("sidebar days", () => {
  it("groups by local calendar day, not by hours ago", () => {
    expect(sidebarDay(at(6, 0), now)).toBe("today");
    expect(sidebarDay(at(5, 23), now)).toBe("yesterday");
    expect(sidebarDay(at(5, 0), now)).toBe("yesterday");
    expect(sidebarDay(at(4, 23), now)).toBe("week");
    expect(sidebarDay(at(0, 0), now)).toBe("week");
    expect(sidebarDay(at(-1, 23), now)).toBe("older");
  });

  it("opens today and yesterday at first, folds the rest, and saves only the reader's change", () => {
    expect((["today", "yesterday", "week", "older"] as const).map((day) => sidebarDayOpen([], day))).toEqual([true, true, false, false]);
    const saved = toggleSidebarFold(toggleSidebarFold([], sidebarDayKey("yesterday")), sidebarDayKey("older"));
    expect(sidebarDayOpen(saved, "yesterday")).toBe(false);
    expect(sidebarDayOpen(saved, "older")).toBe(true);
    expect(sidebarDayOpen(saved, "today")).toBe(true);
  });

  it("files a parent by its family's latest work and keeps the given order", () => {
    const parent = thread("parent", at(1));
    const child = thread("child", now - 1000, { parentThreadId: "parent", parentRelation: "subagent" });
    const sections = sidebarDaySections([thread("a", at(6)), parent, thread("b", at(5)), thread("c", at(1))], [parent, child], now);
    expect(sections.map((section) => [section.day, section.roots.map((root) => root.id)])).toEqual([
      ["today", ["a", "parent"]],
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
    const grows = (roots: ThreadSummary[], collapsed: string[] = [], hasMore = true) => sidebarListGrows({ sections: sidebarDaySections(roots, [], now, hasMore), hasMore, collapsed });
    expect(grows([thread("a", at(6)), thread("b", at(5))])).toBe(true);
    expect(grows([thread("a", at(6)), thread("b", at(5))], [], false)).toBe(false);
    expect(grows([thread("a", at(6)), thread("b", at(3))])).toBe(false);
    expect(grows([thread("a", at(6)), thread("b", at(3))], [sidebarDayKey("week")])).toBe(true);
    expect(grows([thread("a", at(6)), thread("b", at(3))], [sidebarDayKey("older")])).toBe(true);
    expect(grows([thread("a", at(6)), thread("b", at(5))], [sidebarDayKey("yesterday")])).toBe(false);
    expect(grows([thread("a", at(6)), thread("b", at(-2))], [sidebarDayKey("older")])).toBe(false);
    expect(grows([])).toBe(true);
  });

  it("keeps the saved folds the list still has and drops the project groups", () => {
    const saved = ["snoozed", "project:one", "pinned:one", "snoozed-open:one", "pinned:threads", "snoozed-open:threads", "thread-closed:a", "thread-open:b", "day-closed:today", "day-open:older"];
    expect(saved.filter(liveSidebarFold)).toEqual(["pinned:threads", "snoozed-open:threads", "thread-closed:a", "thread-open:b", "day-closed:today", "day-open:older"]);
  });
});
