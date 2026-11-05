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

  it("puts Changes first in the header of a thread with Git, the uncommitted files beneath it, and keeps the rest in order", () => {
    const menu = threadMenu(thread("t-settings"), "header", wednesday, { uncommitted: 3, preview: null });
    const [, ...rest] = outline(threadMenu(thread("t-settings"), "header", wednesday));
    expect(outline(menu)).toEqual([["Changes", "Rename…"], ...rest]);
    expect(menu[0]![0]).toEqual({ kind: "screen", label: "Changes", icon: expect.any(String), subtitle: "3 files", pathname: "/changes" });
    expect(threadMenu(thread("t-settings"), "header", wednesday, { uncommitted: 1, preview: null })[0]![0]).toMatchObject({ label: "Changes", subtitle: "1 file" });
  });

  it("names no count under Changes when nothing waits to be committed", () => {
    const changes = threadMenu(thread("t-settings"), "header", wednesday, { uncommitted: 0, preview: null })[0]![0]!;
    expect(changes.label).toBe("Changes");
    expect(changes).not.toHaveProperty("subtitle");
  });

  it("puts Preview after Changes, with the page the Mac shows for the thread beneath it", () => {
    const menu = threadMenu(thread("t-settings"), "header", wednesday, { uncommitted: 3, preview: { page: "QA Page" } });
    expect(outline(menu)[0]).toEqual(["Changes", "Preview", "Rename…"]);
    expect(menu[0]![1]).toEqual({ kind: "screen", label: "Preview", icon: "globe", pathname: "/preview", subtitle: "QA Page" });
  });

  it("lists Preview while the Mac shows no page, with nothing beneath it", () => {
    const menu = threadMenu(thread("t-settings"), "header", wednesday, { uncommitted: 3, preview: { page: null } });
    expect(outline(menu)[0]).toEqual(["Changes", "Preview", "Rename…"]);
    expect(menu[0]![1]).toEqual({ kind: "screen", label: "Preview", icon: "globe", pathname: "/preview" });
  });

  it("leads with Preview in a thread without Git, and lists none for a Mac that cannot show one", () => {
    expect(outline(threadMenu(thread("t-plan"), "header", wednesday, { uncommitted: null, preview: { page: null } }))[0]).toEqual(["Preview", "Rename…"]);
    expect(outline(threadMenu(thread("t-settings"), "header", wednesday, { uncommitted: 3, preview: null }))[0]).toEqual(["Changes", "Rename…"]);
  });

  it("leaves Changes and Preview out of a Home row's menu", () => {
    const row = outline(threadMenu(thread("t-settings"), "row", wednesday, { uncommitted: 3, preview: { page: "QA Page" } })).flat();
    expect(row).not.toContain("Changes");
    expect(row).not.toContain("Preview");
  });

  it("offers Move to Cloud in the header after the pull request when the thread can move there, and never on a Home row", () => {
    const menu = outline(threadMenu(thread("t-settings"), "header", wednesday, { uncommitted: null, preview: null, toCloud: true }));
    expect(menu[2]).toEqual(["Open Pull Request", "Move to Cloud"]);
    const move = { kind: "screen", label: "Move to Cloud", icon: "icloud.and.arrow.up", pathname: "/move-to-cloud" };
    expect(threadMenu(thread("t-plan"), "header", wednesday, { uncommitted: null, preview: null, toCloud: true }).flat()).toContainEqual(move);
    expect(outline(threadMenu(thread("t-settings"), "header", wednesday)).flat()).not.toContain("Move to Cloud");
    expect(outline(threadMenu(thread("t-settings"), "row", wednesday, { uncommitted: null, preview: null, toCloud: true })).flat()).not.toContain("Move to Cloud");
  });

  it("brings an idle cloud brain thread to the Mac from the header, and offers to keep a thread where it is while it moves", () => {
    const onBrain = { uncommitted: null, preview: null, moves: { mac: "mac-1", onBrain: true } };
    const idle = { ...thread("t-settings"), activity: "idle" as const };
    expect(threadMenu(idle, "header", wednesday, onBrain).flat()).toContainEqual({
      kind: "move",
      label: "Bring to Mac",
      icon: "laptopcomputer.and.arrow.down",
      method: "cloud.bringToMac",
      mac: "mac-1",
    });
    expect(outline(threadMenu({ ...idle, activity: "running" }, "header", wednesday, onBrain)).flat()).not.toContain("Bring to Mac");
    expect(outline(threadMenu(idle, "header", wednesday, { ...onBrain, moves: { mac: "mac-1", onBrain: false } })).flat()).not.toContain("Bring to Mac");
    const coming = { ...idle, moving: { to: "mac" as const, since: 1 } };
    expect(threadMenu(coming, "header", wednesday, onBrain).flat()).toContainEqual({ kind: "move", label: "Keep in Cloud", icon: "icloud", method: "cloud.keep", mac: "mac-1" });
    const leaving = { ...idle, moving: { to: "cloud" as const, since: 1 } };
    expect(outline(threadMenu(leaving, "header", wednesday, { ...onBrain, moves: { mac: "mac-1", onBrain: false } })).flat()).toContain("Keep on Mac");
    expect(outline(threadMenu(coming, "header", wednesday)).flat()).not.toContain("Keep in Cloud");
    expect(outline(threadMenu(idle, "row", wednesday, onBrain)).flat()).not.toContain("Bring to Mac");
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

it("offers only parent navigation for a hosted child even when Git, cloud, and preview exist", () => {
  const child = { ...thread("t-settings"), parentThreadId: "parent", parentRelation: "subagent" as const };
  for (const place of ["row", "header"] as const) {
    expect(outline(threadMenu(child, place, wednesday, { uncommitted: 3, preview: { page: "Docs" }, toCloud: true }))).toEqual([["Open parent"]]);
  }
  expect(
    threadMenu({ ...child, parentRelation: "started" }, "header", wednesday)
      .flat()
      .some((item) => item.kind === "rename"),
  ).toBe(true);
});
