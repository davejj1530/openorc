import { describe, expect, it } from "vitest";
import { fixtureThreads } from "../home/test-fixtures/threads";
import { threadMenu, type ThreadAction } from "./thread-actions";

const thread = (id: string) => fixtureThreads.find((item) => item.id === id)!;
const wednesday = new Date(2026, 9, 21, 14);
const outline = (sections: ThreadAction[][]) =>
  sections.map((section) => section.map((action) => (action.kind === "menu" ? `${action.label} ▸ ${action.actions.map((item) => item.label).join(", ")}` : action.label)));

describe("a thread's menu on the phone", () => {
  it("leads with New Subthread, then the desktop's organizing actions, and nothing that deletes, forks or moves", () => {
    expect(outline(threadMenu(thread("t-plan"), "row", wednesday))).toEqual([
      ["New Subthread"],
      ["Pin", "Snooze ▸ In 1 hour, In 3 hours, This evening, Tomorrow morning, Next week", "Mark as Unread"],
      ["Rename…"],
      ["Resolve"],
    ]);
  });

  it("turns each action around for a pinned, unread, snoozed or resolved thread, with the pull request beside Rename", () => {
    const notes = { ...thread("t-headline"), unread: true, snoozedUntil: wednesday.getTime() + 60_000, archivedAt: 1 };
    expect(outline(threadMenu(notes, "row", wednesday))).toEqual([
      ["New Subthread"],
      ["Unpin", "Snoozed ▸ In 1 hour, In 3 hours, This evening, Tomorrow morning, Next week, Wake Now", "Mark as Read"],
      ["Rename…", "Open Pull Request"],
      ["Reopen"],
    ]);
  });

  it("leads with Rename in the thread's header, with New Subthread after it", () => {
    expect(outline(threadMenu(thread("t-settings"), "header", wednesday)).map((section) => section[0])).toEqual(["Rename…", "New Subthread", "Pin", "Open Pull Request", "Resolve"]);
  });

  it("starts a subthread under any thread but a team's or an Orcling's", () => {
    expect(threadMenu(thread("t-plan"), "row", wednesday)[0]).toEqual([{ kind: "screen", label: "New Subthread", icon: "square.and.pencil", pathname: "/new-subthread" }]);
    for (const other of [{ teamInstanceId: "team-1" }, { orclingId: "orc-1" }]) {
      for (const place of ["row", "header"] as const) expect(outline(threadMenu({ ...thread("t-plan"), ...other }, place, wednesday)).flat()).not.toContain("New Subthread");
    }
  });

  it("starts one under a cloud thread from its header once its server serves it, never from its row", () => {
    const cloud = { ...thread("t-plan"), owner: { brain: "hosted" as const, reach: "live" as const, heardAt: 0 } };
    const panels = { uncommitted: null, preview: null };
    expect(outline(threadMenu(cloud, "header", wednesday, panels)).flat()).not.toContain("New Subthread");
    expect(outline(threadMenu(cloud, "header", wednesday, { ...panels, startsUnder: true })).flat()).toContain("New Subthread");
    expect(outline(threadMenu(cloud, "row", wednesday)).flat()).not.toContain("New Subthread");
  });

  it("puts Changes first in the header of a thread with Git, the uncommitted files beneath it, and keeps the rest in order", () => {
    const menu = threadMenu(thread("t-settings"), "header", wednesday, { uncommitted: 3, preview: null });
    const [, ...rest] = outline(threadMenu(thread("t-settings"), "header", wednesday));
    expect(outline(menu)).toEqual([["Changes", "Rename…"], ...rest]);
    expect(menu[0]![0]).toEqual({ kind: "screen", label: "Changes", icon: expect.any(String), subtitle: "3 files", pathname: "/changes" });
    expect(threadMenu(thread("t-settings"), "header", wednesday, { uncommitted: 1, preview: null })[0]![0]).toMatchObject({ label: "Changes", subtitle: "1 file" });
  });

  it("leads a subthread back to its parent and lists a thread's subthreads in the header, after Rename", () => {
    const child = { ...thread("t-settings"), parentThreadId: "t-plan" };
    const menu = threadMenu(child, "header", wednesday, { uncommitted: null, preview: null, subthreads: 2 });
    expect(outline(menu)[1]).toEqual(["New Subthread", "Open Parent Thread", "Subthreads"]);
    expect(menu[1]).toEqual([
      { kind: "screen", label: "New Subthread", icon: expect.any(String), pathname: "/new-subthread" },
      { kind: "parent", label: "Open Parent Thread", icon: expect.any(String), threadId: "t-plan" },
      { kind: "screen", label: "Subthreads", icon: expect.any(String), subtitle: "2", pathname: "/subthreads" },
    ]);
    expect(outline(threadMenu(thread("t-settings"), "header", wednesday)).flat()).not.toContain("Subthreads");
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

  it("offers no move for a thread an older Mac runs in a sandbox, brought from its brain or sent there", () => {
    const sandboxed = { ...thread("t-settings"), activity: "idle" as const, cloud: { provider: "vercel" as const, state: "ready" as const, step: null, setup: true, error: null } };
    for (const each of [sandboxed, { ...sandboxed, moving: { to: "mac" as const, failed: null } }, { ...sandboxed, moving: { to: "cloud" as const, failed: null } }]) {
      const header = outline(threadMenu(each, "header", wednesday, { uncommitted: null, preview: null }));
      expect(header).toEqual(outline(threadMenu(thread("t-settings"), "header", wednesday, { uncommitted: null, preview: null })));
      expect(header.flat().filter((label) => /Cloud|Mac/.test(label))).toEqual([]);
    }
  });

  it("leaves a team thread's snooze and resolving to the team on the Mac", () => {
    expect(outline(threadMenu({ ...thread("t-plan"), teamInstanceId: "team-1" }, "row", wednesday))).toEqual([["Pin", "Mark as Unread"], ["Rename…"]]);
  });

  it("saves each change as the patch the phone may send", () => {
    const [, organize, , resolve] = threadMenu(thread("t-plan"), "row", wednesday);
    const snooze = organize![1]!;
    expect(organize![0]).toMatchObject({ patch: { pinned: true } });
    const inAnHour = snooze.kind === "menu" ? snooze.actions[0] : undefined;
    expect(inAnHour?.kind === "snooze" && inAnHour.until(wednesday)).toBe(wednesday.getTime() + 3_600_000);
    expect(organize![2]).toMatchObject({ patch: { seen: false } });
    expect(resolve![0]).toMatchObject({ patch: { archived: true } });
  });
});

it("offers only parent navigation for a hosted child even when Git and preview exist", () => {
  const child = { ...thread("t-settings"), parentThreadId: "parent", parentRelation: "subagent" as const };
  for (const place of ["row", "header"] as const) {
    expect(outline(threadMenu(child, place, wednesday, { uncommitted: 3, preview: { page: "Docs" } }))).toEqual([["Open parent"]]);
  }
  expect(
    threadMenu({ ...child, parentRelation: "started" }, "header", wednesday)
      .flat()
      .some((item) => item.kind === "rename"),
  ).toBe(true);
});

it("ends a cloud thread's menu with Delete, its Changes opening OpenOrc Cloud's own, and offers neither for a thread of the Mac's", () => {
  const cloud = { ...thread("t-plan"), owner: { brain: "hosted" as const, reach: "live" as const, heardAt: 0 } };
  for (const place of ["row", "header"] as const) expect(threadMenu(cloud, place, wednesday, { uncommitted: 2, preview: null }).at(-1)).toEqual([{ kind: "delete", label: "Delete…", icon: "trash" }]);
  expect(threadMenu(cloud, "header", wednesday, { uncommitted: 2, preview: null })[0]![0]).toMatchObject({ label: "Changes", pathname: "/cloud-changes", subtitle: "2 files" });
  const mac = threadMenu(thread("t-plan"), "header", wednesday, { uncommitted: 2, preview: null });
  expect(mac.flat().some((item) => item.kind === "delete")).toBe(false);
  expect(mac[0]![0]).toMatchObject({ pathname: "/changes" });
});

it("offers Compact Context in the header while the thread's place compacts it, and nowhere else", () => {
  const header = threadMenu(thread("t-plan"), "header", wednesday, { uncommitted: null, preview: null, compact: true });
  expect(header.flat().find((item) => item.kind === "compact")).toEqual({ kind: "compact", label: "Compact Context", icon: "arrow.down.right.and.arrow.up.left" });
  expect(
    threadMenu(thread("t-plan"), "row", wednesday, { uncommitted: null, preview: null, compact: true })
      .flat()
      .some((item) => item.kind === "compact"),
  ).toBe(false);
  expect(
    threadMenu(thread("t-plan"), "header", wednesday)
      .flat()
      .some((item) => item.kind === "compact"),
  ).toBe(false);
});
