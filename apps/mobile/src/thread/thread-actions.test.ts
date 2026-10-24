import { describe, expect, it } from "vitest";
import { fixtureThreads } from "../home/test-fixtures/threads";
import { threadMenu, type ThreadAction } from "./thread-actions";

const thread = (id: string) => fixtureThreads.find((item) => item.id === id)!;
const wednesday = new Date(2026, 9, 21, 14);
const outline = (sections: ThreadAction[][]) =>
  sections.map((section) => section.map((action) => (action.kind === "menu" ? `${action.label} ▸ ${action.actions.map((item) => item.label).join(", ")}` : action.label)));

describe("a thread's menu on the phone", () => {
  it("offers the desktop's organizing actions, and nothing that deletes, forks or moves", () => {
    expect(outline(threadMenu(thread("t-plan"), "row", wednesday))).toEqual([
      ["Pin", "Snooze ▸ In 1 hour, In 3 hours, This evening, Tomorrow morning, Next week", "Mark as Unread"],
      ["Rename…"],
      ["Archive"],
    ]);
  });

  it("turns each action around for a pinned, unread, snoozed or archived thread, with the pull request beside Rename", () => {
    const notes = { ...thread("t-headline"), unread: true, snoozedUntil: wednesday.getTime() + 60_000, archivedAt: 1 };
    expect(outline(threadMenu(notes, "row", wednesday))).toEqual([
      ["Unpin", "Snoozed ▸ In 1 hour, In 3 hours, This evening, Tomorrow morning, Next week, Wake Now", "Mark as Read"],
      ["Rename…", "Open Pull Request"],
      ["Unarchive"],
    ]);
  });

  it("leads with Rename in the thread's header", () => {
    expect(outline(threadMenu(thread("t-settings"), "header", wednesday)).map((section) => section[0])).toEqual(["Rename…", "Pin", "Open Pull Request", "Archive"]);
  });

  it("leaves a team thread's snooze and archive to the team on the Mac", () => {
    expect(outline(threadMenu({ ...thread("t-plan"), teamInstanceId: "team-1" }, "row", wednesday))).toEqual([["Pin", "Mark as Unread"], ["Rename…"]]);
  });

  it("saves each change as the patch the phone may send", () => {
    const [organize, , archive] = threadMenu(thread("t-plan"), "row", wednesday);
    const snooze = organize![1]!;
    expect(organize![0]).toMatchObject({ patch: { pinned: true } });
    const inAnHour = snooze.kind === "menu" ? snooze.actions[0] : undefined;
    expect(inAnHour?.kind === "snooze" && inAnHour.until(wednesday)).toBe(wednesday.getTime() + 3_600_000);
    expect(organize![2]).toMatchObject({ patch: { seen: false } });
    expect(archive![0]).toMatchObject({ patch: { archived: true } });
  });
});
