import type { ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { projectGroups } from "./sidebar-groups.js";
import { callsThePerson, edgeWords, inListOrder, listLayout, moreRows, nearestPast, pastEdges, pinOrder, projectRows, rootStatuses, scrollToBring, type ListLayout } from "./sidebar-list.js";
import { threadTreeActivity } from "./thread-tree.js";

const MIN = 60_000;
const NINE = new Date(2026, 10, 14, 9, 0).getTime();

function thread(id: string, projectId: string, activeMinutesAgo: number, values: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id,
    projectId,
    title: id,
    parentThreadId: null,
    createdAt: NINE - activeMinutesAgo * MIN,
    lastActivityAt: NINE - activeMinutesAgo * MIN,
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

/** One list's day: its threads, most recently active first as the day's list reads them, its layout, and whether the pointer is on it. */
function day(threads: ThreadSummary[]) {
  let rows = threads;
  let layout: ListLayout | null = null;
  let now = NINE;
  const projects = [...new Set(threads.map((t) => t.projectId))].map((id) => ({ id, name: id }));
  const latestFirst = () => [...rows].sort((a, b) => threadTreeActivity(b, rows) - threadTreeActivity(a, rows) || b.id.localeCompare(a.id));
  const settle = (held = false, own: string[] = []) => {
    const statuses = rootStatuses(rows, rows);
    layout = listLayout(layout, { groups: projectGroups(projects, latestFirst(), rows), quiet: (root) => !statuses.get(root.id), now, held, own });
  };
  settle();
  return {
    at(minutes: number) {
      now = NINE + minutes * MIN;
    },
    change(id: string, values: Partial<ThreadSummary>) {
      rows = rows.map((t) => (t.id === id ? { ...t, ...values } : t));
    },
    /** Work in a thread at `minutes` past nine. */
    touch(id: string, minutes: number, values: Partial<ThreadSummary> = {}) {
      this.change(id, { lastActivityAt: NINE + minutes * MIN, ...values });
    },
    start(row: ThreadSummary) {
      rows = [...rows, row];
    },
    settle,
    roots(project: string) {
      return latestFirst().filter((t) => t.projectId === project);
    },
    shown(project: string) {
      return projectRows(this.roots(project), { rows: layout!.rows.get(project) ?? [], open: true, holdsActive: () => false });
    },
    ids(project: string) {
      return this.shown(project).rows.map((t) => t.id);
    },
    layout: () => layout!,
  };
}

/** The morning of the scripted day: openorc with a working thread among quiet ones, canvas quiet. */
function morning() {
  return day([
    thread("o-retry", "openorc", 120, running),
    thread("o-audit", "openorc", 200),
    thread("o-electron", "openorc", 300),
    thread("o-dock", "openorc", 60),
    thread("o-old-1", "openorc", 900),
    thread("o-old-2", "openorc", 1000),
    thread("i-chart", "canvas", 50, running),
    thread("i-first", "canvas", 400),
    thread("i-tokens", "canvas", 1400),
    thread("i-old", "canvas", 2000),
  ]);
}

describe("the Workspaces list by last activity, through the scripted day", () => {
  it("the day opens: each project shows its four most recently active threads, the most recent on top", () => {
    const list = morning();
    expect(list.ids("openorc")).toEqual(["o-dock", "o-retry", "o-audit", "o-electron"]);
    expect(list.shown("openorc").hidden).toBe(2);
    expect(list.ids("canvas")).toEqual(["i-chart", "i-first", "i-tokens", "i-old"]);
  });

  it("a quiet thread gets activity: it rises to its project's top, and the quiet one it pushes past four goes behind Show N more", () => {
    const list = morning();
    list.touch("o-electron", 5);
    list.settle();
    expect(list.ids("openorc")).toEqual(["o-electron", "o-dock", "o-retry", "o-audit"]);
    list.touch("o-old-1", 6);
    list.settle();
    expect(list.ids("openorc")).toEqual(["o-old-1", "o-electron", "o-dock", "o-retry"]);
    expect(list.shown("openorc").hidden).toBe(2);
  });

  it("activity under the pointer: no row rises, arrives or leaves until the pointer leaves, then it lands", () => {
    const list = morning();
    const before = list.ids("openorc");
    list.at(20);
    list.touch("o-old-1", 20);
    list.start(thread("o-truth", "openorc", -20, running));
    list.settle(true);
    expect(list.ids("openorc")).toEqual(before);
    list.settle(false);
    expect(list.ids("openorc")).toEqual(["o-truth", "o-old-1", "o-dock", "o-retry"]);
  });

  it("a thread starts: it joins its project on top, and a quiet one past four leaves for it", () => {
    const list = morning();
    list.at(15);
    list.start(thread("i-layers", "canvas", -15, running));
    list.settle();
    expect(list.ids("canvas")).toEqual(["i-layers", "i-chart", "i-first", "i-tokens"]);
    expect(list.shown("canvas").hidden).toBe(1);
  });

  it("a failure turns its row where it is, and its retry, being activity, takes it to the top", () => {
    const list = morning();
    const before = list.ids("openorc");
    list.change("o-retry", { activity: "idle", ...failed });
    list.settle();
    expect(list.ids("openorc")).toEqual(before);
    list.touch("o-retry", 21, { session: { status: "idle", message: null }, ...running });
    list.settle();
    expect(list.ids("openorc")).toEqual(["o-retry", "o-dock", "o-audit", "o-electron"]);
  });

  it("a thread past the four that is not quiet shows after them, in its place by activity", () => {
    const list = morning();
    list.change("o-old-1", waiting);
    list.settle();
    expect(list.ids("openorc")).toEqual(["o-dock", "o-retry", "o-audit", "o-electron", "o-old-1"]);
  });

  it("seven threads, three of them busy past the four: the four most recent and the three busy show, the quiet rest behind Show N more", () => {
    const list = day([
      thread("s1", "studio", 1),
      thread("s2", "studio", 2),
      thread("s3", "studio", 3),
      thread("s4", "studio", 4),
      thread("s5", "studio", 5, running),
      thread("s6", "studio", 6),
      thread("s7", "studio", 7, { unread: true }),
      thread("s8", "studio", 8, { backgroundCommands: [{}] } as Partial<ThreadSummary>),
      thread("s9", "studio", 9),
    ]);
    expect(list.ids("studio")).toEqual(["s1", "s2", "s3", "s4", "s5", "s7", "s8"]);
    expect(list.shown("studio").hidden).toBe(2);
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
  it("nine at work: a project with more than four threads that are not quiet shows them all, the most recent on top, and Show N more counts only the quiet ones", () => {
    const threads = Array.from({ length: 9 }, (_, index) => thread(`w${index}`, "studio", index + 1, index === 4 ? waiting : running));
    const list = day([...threads, thread("q1", "studio", 600), thread("q2", "studio", 700)]);
    expect(list.ids("studio")).toEqual(threads.map((t) => t.id));
    expect(list.shown("studio").hidden).toBe(2);
  });
  it("Show N more opens ten more of what is behind it, the most recently active first, at once even with the pointer on the list", () => {
    const list = day(Array.from({ length: 16 }, (_, index) => thread(`t${index}`, "openorc", index)));
    expect(list.shown("openorc").hidden).toBe(12);
    const more = moreRows(list.roots("openorc"), list.layout().rows.get("openorc")!);
    expect(more).toEqual(["t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12", "t13"]);
    list.settle(true, more);
    expect(list.ids("openorc")).toEqual(Array.from({ length: 14 }, (_, index) => `t${index}`));
  });

  it("a fold by hand with a question behind it: the fold holds, shows only the open thread's tree, and its label counts the question", () => {
    const list = morning();
    list.change("i-first", waiting);
    list.settle();
    const roots = list.roots("canvas");
    expect(projectRows(roots, { rows: list.layout().rows.get("canvas")!, open: false, holdsActive: () => false })).toEqual({ rows: [], hidden: 0 });
    expect(projectGroups([{ id: "canvas", name: "canvas" }], roots, roots)[0]!.waiting).toBe(1);
  });

  it("a pin: Pinned keeps the order things were pinned in, whatever works", () => {
    const pins = [thread("b", "openorc", 5, { pinnedAt: NINE + 2 * MIN, ...running }), thread("a", "openorc", 500, { pinnedAt: NINE + MIN })];
    expect(pinOrder(pins).map((t) => t.id)).toEqual(["a", "b"]);
  });
  it("two projects need the person: neither row moves for it, and the edge counts what is past it", () => {
    const list = morning();
    const openorc = list.ids("openorc");
    const canvas = list.ids("canvas");
    list.change("o-retry", waiting);
    list.change("i-chart", { activity: "idle", ...failed });
    list.settle();
    expect([list.ids("openorc"), list.ids("canvas")]).toEqual([openorc, canvas]);
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
  it("a snooze ends: the thread is back in its project by its last activity with its unread dot, after the pointer leaves", () => {
    const list = morning();
    list.at(300);
    list.start(thread("o-schema", "openorc", 90, { unread: true }));
    list.settle(true);
    expect(list.ids("openorc")).not.toContain("o-schema");
    list.settle(false);
    expect(list.ids("openorc")).toEqual(["o-dock", "o-schema", "o-retry", "o-audit"]);
  });

  it("the open thread keeps its row past the four", () => {
    const list = morning();
    list.settle(false, ["o-old-2"]);
    expect(list.ids("openorc")).toEqual(["o-dock", "o-retry", "o-audit", "o-electron", "o-old-2"]);
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
    let layout = listLayout(null, { groups: groups(["openorc", "canvas", "website"]), quiet, now: NINE, held: false, own: [] });
    layout = listLayout(layout, { groups: groups(["website", "openorc", "canvas"]), quiet, now: NINE + MIN, held: false, own: [] });
    expect(inListOrder(groups(["website", "openorc", "canvas"]), layout).map((g) => g.project.id)).toEqual(["openorc", "canvas", "website"]);
    layout = listLayout(layout, { groups: groups(["website", "atlas", "openorc", "canvas"]), quiet, now: NINE + 2 * MIN, held: false, own: [] });
    expect(inListOrder(groups(["website", "atlas", "openorc", "canvas"]), layout).map((g) => g.project.id)).toEqual(["atlas", "openorc", "canvas", "website"]);
  });
});
