import type { ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { projectGroups } from "./sidebar-groups.js";
import {
  callsThePerson,
  edgeWords,
  inListOrder,
  listMembers,
  moreRows,
  nearestPast,
  pastEdges,
  pinOrder,
  projectRows,
  rootStatuses,
  scrollToBring,
  startedFirst,
  type ListMembers,
} from "./sidebar-list.js";

const MIN = 60_000;
const NINE = new Date(2026, 10, 14, 9, 0).getTime();

function thread(id: string, projectId: string, startedMinutesAgo: number, values: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id,
    projectId,
    title: id,
    parentThreadId: null,
    createdAt: NINE - startedMinutesAgo * MIN,
    lastActivityAt: NINE - startedMinutesAgo * MIN,
    archivedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    activity: "idle",
    unread: false,
    session: { status: "idle", message: null },
    ...values,
  } as ThreadSummary;
}

const running = { activity: "running" } as const;
const waiting = { activity: "waiting" } as const;
const failed = { session: { status: "error", message: null } } as const;

/** One list's day: its threads, its memory, and whether the pointer is on it. */
function day(threads: ThreadSummary[]) {
  let rows = threads;
  let members: ListMembers | null = null;
  let now = NINE;
  const projects = [...new Set(threads.map((t) => t.projectId))].map((id) => ({ id, name: id }));
  const settle = (held = false, own: string[] = []) => {
    const statuses = rootStatuses(rows, rows);
    members = listMembers(members, { groups: projectGroups(projects, rows, rows), quiet: (root) => !statuses.get(root.id), now, held, own });
  };
  settle();
  return {
    at(minutes: number) {
      now = NINE + minutes * MIN;
    },
    change(id: string, values: Partial<ThreadSummary>) {
      rows = rows.map((t) => (t.id === id ? { ...t, ...values } : t));
    },
    start(row: ThreadSummary) {
      rows = [...rows, row];
    },
    settle,
    shown(project: string, active: string | null = null) {
      return projectRows(
        rows.filter((t) => t.projectId === project),
        { members: members!.ids, open: true, holdsActive: (root) => root.id === active },
      );
    },
    ids(project: string, active: string | null = null) {
      return this.shown(project, active).rows.map((t) => t.id);
    },
    members: () => members!,
    rows: () => rows,
  };
}

/** The morning of the scripted day: openorc with a working thread among quiet ones, immaculate quiet. */
function morning() {
  return day([
    thread("o-retry", "openorc", 120, running),
    thread("o-audit", "openorc", 200),
    thread("o-electron", "openorc", 300),
    thread("o-dock", "openorc", 60),
    thread("o-old-1", "openorc", 900),
    thread("o-old-2", "openorc", 1000),
    thread("i-chart", "immaculate", 50, running),
    thread("i-first", "immaculate", 400),
    thread("i-tokens", "immaculate", 1400),
    thread("i-old", "immaculate", 2000),
  ]);
}

describe("the list that holds still, through the scripted day", () => {
  it("the day opens: each project shows every thread that is not quiet and its newest quiet ones, four rows, the newest started on top", () => {
    const list = morning();
    expect(list.ids("openorc")).toEqual(["o-dock", "o-retry", "o-audit", "o-electron"]);
    expect(list.shown("openorc").hidden).toBe(2);
    expect(list.ids("immaculate")).toEqual(["i-chart", "i-first", "i-tokens", "i-old"]);
  });

  it("a sixth thread starts: it joins its project on top and no row leaves for it", () => {
    const list = morning();
    list.at(15);
    list.start(thread("i-layers", "immaculate", -15, running));
    list.settle();
    expect(list.ids("immaculate")).toEqual(["i-layers", "i-chart", "i-first", "i-tokens", "i-old"]);
    expect(list.shown("immaculate").hidden).toBe(0);
  });

  it("a thread that starts under the pointer waits, and lands when the pointer leaves", () => {
    const list = morning();
    list.at(20);
    list.start(thread("o-truth", "openorc", -20, running));
    list.settle(true);
    expect(list.ids("openorc")).toEqual(["o-dock", "o-retry", "o-audit", "o-electron"]);
    list.settle(false);
    expect(list.ids("openorc")).toEqual(["o-truth", "o-dock", "o-retry", "o-audit", "o-electron"]);
  });

  it("a failure and its retry: the row turns where it is, and finishing or being read never moves or drops it", () => {
    const list = morning();
    const before = list.ids("immaculate");
    list.change("i-chart", { activity: "idle", ...failed });
    list.settle();
    expect(list.ids("immaculate")).toEqual(before);
    list.change("i-chart", { session: { status: "idle", message: null }, ...running, lastActivityAt: NINE + 21 * MIN });
    list.settle();
    expect(list.ids("immaculate")).toEqual(before);
    list.change("i-chart", { activity: "idle", unread: false });
    list.settle();
    expect(list.ids("immaculate")).toEqual(before);
  });

  it("a quiet thread past the page that wakes with a question joins in its own place, never on top", () => {
    const list = morning();
    list.change("o-old-1", waiting);
    list.settle();
    expect(list.ids("openorc")).toEqual(["o-dock", "o-retry", "o-audit", "o-electron", "o-old-1"]);
  });

  it("a question out of view: named at the edge it is past, with its title, and a press brings it whole below the line", () => {
    const targets = [
      { id: "o-dock", top: 40, bottom: 84 },
      { id: "i-chart", top: 300, bottom: 344 },
    ];
    const edges = pastEdges(targets, { top: 120, bottom: 520 }, 28);
    expect(edges).toEqual({ above: ["o-dock"], below: [] });
    expect(edgeWords(edges.above, (id) => (id === "o-dock" ? "Dock a waiting question onto the composer" : id))).toBe("Dock a waiting question onto the composer");
    expect(nearestPast(edges, "above")).toBe("o-dock");
    expect(scrollToBring(targets[0]!, { top: 120, height: 400 }, 28)).toBe(0);
    expect(scrollToBring({ id: "y", top: 260, bottom: 304 }, { top: 400, height: 400 }, 28)).toBe(224);
    expect(scrollToBring({ id: "x", top: 900, bottom: 944 }, { top: 120, height: 400 }, 28)).toBe(580);
  });

  it("a row under an edge's line counts as past that edge, and a row whole in view is never named", () => {
    expect(
      pastEdges(
        [
          { id: "a", top: 0, bottom: 44 },
          { id: "b", top: 110, bottom: 154 },
        ],
        { top: 100, bottom: 500 },
        28,
      ),
    ).toEqual({ above: ["a", "b"], below: [] });
    expect(pastEdges([{ id: "a", top: 200, bottom: 244 }], { top: 100, bottom: 500 }, 28)).toEqual({ above: [], below: [] });
  });

  it("nine at work: a project with more than four threads that are not quiet shows them all, and Show N more counts only the quiet ones", () => {
    const threads = Array.from({ length: 9 }, (_, index) => thread(`w${index}`, "studio", index + 1, index === 4 ? waiting : running));
    const list = day([...threads, thread("q1", "studio", 600), thread("q2", "studio", 700)]);
    expect(list.ids("studio")).toEqual(threads.map((t) => t.id));
    expect(list.shown("studio").hidden).toBe(2);
  });

  it("Show N more opens ten more of what is behind it in place, the newest first, even with the pointer on the list", () => {
    const list = day(Array.from({ length: 16 }, (_, index) => thread(`t${index}`, "openorc", index)));
    expect(list.shown("openorc").hidden).toBe(12);
    const more = moreRows(
      list.rows().filter((t) => t.projectId === "openorc"),
      list.members().ids,
    );
    expect(more).toEqual(["t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12", "t13"]);
    list.settle(true, more);
    expect(list.ids("openorc")).toEqual(
      startedFirst(list.rows())
        .slice(0, 14)
        .map((t) => t.id),
    );
  });

  it("a fold by hand with a question behind it: the fold holds, shows only the open thread's tree, and its label counts the question", () => {
    const list = morning();
    list.change("i-first", waiting);
    list.settle();
    const roots = list.rows().filter((t) => t.projectId === "immaculate");
    expect(projectRows(roots, { members: list.members().ids, open: false, holdsActive: () => false })).toEqual({ rows: [], hidden: 0 });
    expect(projectGroups([{ id: "immaculate", name: "immaculate" }], roots, roots)[0]!.waiting).toBe(1);
  });

  it("a pin: Pinned keeps the order things were pinned in, whatever works", () => {
    const pins = [thread("b", "openorc", 5, { pinnedAt: NINE + 2 * MIN, ...running }), thread("a", "openorc", 500, { pinnedAt: NINE + MIN })];
    expect(pinOrder(pins).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("two projects need the person: neither moves, and the edge counts what is past it", () => {
    const list = morning();
    const openorc = list.ids("openorc");
    const immaculate = list.ids("immaculate");
    list.change("o-retry", waiting);
    list.change("i-chart", { activity: "idle", ...failed });
    list.settle();
    expect([list.ids("openorc"), list.ids("immaculate")]).toEqual([openorc, immaculate]);
    const edges = pastEdges(
      [
        { id: "o-retry", top: 600, bottom: 644 },
        { id: "i-chart", top: 900, bottom: 944 },
      ],
      { top: 0, bottom: 500 },
      28,
    );
    expect(edgeWords(edges.below, String)).toBe("2 need you");
    expect(nearestPast(edges, "below")).toBe("o-retry");
  });

  it("a snooze ends: the thread is back in its project in its started place with its unread dot, after the pointer leaves", () => {
    const list = morning();
    list.at(300);
    list.start(thread("o-schema", "openorc", 90, { unread: true }));
    list.settle(true);
    expect(list.ids("openorc")).not.toContain("o-schema");
    list.settle(false);
    expect(list.ids("openorc")).toEqual(["o-dock", "o-schema", "o-retry", "o-audit", "o-electron"]);
  });

  it("the open thread keeps its row past the page, and the next day the list opens fresh", () => {
    const list = morning();
    expect(list.ids("openorc", "o-old-2")).toContain("o-old-2");
    list.settle(false, ["o-old-2"]);
    expect(list.ids("openorc")).toContain("o-old-2");
    list.at(24 * 60);
    list.settle();
    expect(list.ids("openorc")).toEqual(["o-dock", "o-retry", "o-audit", "o-electron"]);
  });

  it("calls the person for a question, a failure and an unread result, never for work under way or a command left running", () => {
    const rows = [
      thread("q", "p", 1, waiting),
      thread("f", "p", 1, failed),
      thread("u", "p", 1, { unread: true }),
      thread("r", "p", 1, running),
      thread("b", "p", 1, { backgroundCommands: [{}] } as Partial<ThreadSummary>),
    ];
    const statuses = rootStatuses(rows, rows);
    expect(rows.filter((t) => callsThePerson(statuses.get(t.id))).map((t) => t.id)).toEqual(["q", "f", "u"]);
    expect(rows.filter((t) => statuses.get(t.id)).length).toBe(5);
  });

  it("projects keep the order the day found them in when work in one would list it first, and one added since leads", () => {
    const groups = (ids: string[]) => ids.map((id) => ({ project: { id }, roots: [] as ThreadSummary[] }));
    const quiet = () => true;
    let members = listMembers(null, { groups: groups(["openorc", "immaculate", "website"]), quiet, now: NINE, held: false, own: [] });
    members = listMembers(members, { groups: groups(["website", "openorc", "immaculate"]), quiet, now: NINE + MIN, held: false, own: [] });
    expect(inListOrder(groups(["website", "openorc", "immaculate"]), members).map((g) => g.project.id)).toEqual(["openorc", "immaculate", "website"]);
    members = listMembers(members, { groups: groups(["website", "atlas", "openorc", "immaculate"]), quiet, now: NINE + 2 * MIN, held: false, own: [] });
    expect(inListOrder(groups(["website", "atlas", "openorc", "immaculate"]), members).map((g) => g.project.id)).toEqual(["atlas", "openorc", "immaculate", "website"]);
  });
});
