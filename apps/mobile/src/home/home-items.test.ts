import { sidebarDayList, sidebarThreadPage, THREAD_PAGE, type ListLayout, type SidebarFilter } from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { homeCalls, homeItems, homeLayout, type HomeItem, type HomeList, type HomeOptions, type HomeProject, type ProjectResolved } from "./home-items";
import { fixtureProjects, fixtureThreads } from "./test-fixtures/threads";

const outline = (items: HomeItem[]) =>
  items.map((item) => {
    if (item.kind === "section") return `§ ${item.label} ${item.count}${item.open ? "" : " folded"}`;
    if (item.kind === "day") return `~ ${item.label}`;
    if (item.kind === "resolved") return `> Resolved${item.open ? "" : " folded"}`;
    if (item.kind === "resolved-more") return "more resolved";
    if (item.kind === "resolved-none") return item.pending ? "loading resolved" : "no resolved";
    if (item.kind === "project") return `# ${item.project.name}${item.waiting ? ` (${item.waiting})` : ""}${item.open ? "" : " folded"}`;
    if (item.kind === "group-more") return `show ${item.count} more`;
    if (item.kind === "children-more") return `more ${item.count} in ${item.tree.thread.id}`;
    if (item.kind === "more") return "more";
    if (item.kind === "retry") return `retry ${item.projects ? "projects" : "threads"}`;
    if (item.kind === "empty") return "no threads yet";
    return item.project ? `${item.thread.id} @ ${item.project}` : item.thread.id;
  });
/** The project labels and their rows alone. */
const groups = (items: HomeItem[]) => {
  const lines = outline(items);
  const end = lines.findIndex((line) => line.startsWith("§ Snoozed"));
  return lines.slice(
    lines.findIndex((line) => line.startsWith("#")),
    end === -1 ? undefined : end,
  );
};

const now = Date.UTC(2026, 9, 23, 12);
const names = new Map([[WORKSPACE_ID, "Workspace"], ...fixtureProjects.map(({ id, name }): [string, string] => [id, name])]);
const projects: HomeProject[] = [...fixtureProjects.map(({ id, name }) => ({ id, name })), { id: WORKSPACE_ID, name: "No project" }];
/** Nothing folded or opened by the reader: every project open, every Resolved folded. */
const allOpen: string[] = [];

/** What a host's lists give Home: one page across projects, newest work first, and every pin from its own read. */
function list(
  threads: readonly ThreadSummary[] = fixtureThreads,
  more: { pinnedOnly?: boolean; limit?: number; failed?: boolean; activeId?: string; at?: number; groups?: HomeProject[]; resolvedOpen?: string[]; counted?: boolean } = {},
): HomeList {
  const { pinnedOnly = false, limit = 100, failed = false, activeId, at = now, groups: shown = projects, resolvedOpen = [], counted = true } = more;
  const sorted = threads.filter((thread) => !pinnedOnly || thread.pinnedAt).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const page = (filter: SidebarFilter, rows: readonly ThreadSummary[], count: number) => sidebarThreadPage({ projectId: WORKSPACE_ID, fetched: rows, selected: null, filter, limit: count, now: at });
  const pins = pinnedOnly
    ? undefined
    : page(
        "active",
        sorted.filter((thread) => thread.pinnedAt),
        Number.MAX_SAFE_INTEGER,
      );
  const days = sidebarDayList({ pages: [page("active", sorted, limit)], pins, pinnedOnly, activeId, now: at });
  // Each project's Resolved as Home reads it: none where the host counts none (`counted`), an opened one from the project's own read.
  const resolved = (projectId: string): ProjectResolved | null => {
    const own = sorted.filter((thread) => thread.projectId === projectId);
    const read = sidebarDayList({ pages: [page("active", own, limit)], resolved: page("archived", own, limit), pinnedOnly: false, activeId, now: at });
    if (counted && !read.resolved.roots.length) return null;
    if (resolvedOpen.includes(projectId)) return { open: true, roots: read.resolved.roots, all: read.all, hasMore: read.resolved.hasMore, pending: false };
    return { open: false, roots: days.shown(days.resolved.roots, false).filter((root) => root.projectId === projectId), all: days.all, hasMore: false, pending: false };
  };
  return {
    days,
    names,
    groups: shown,
    groupOf: new Map(shown.map(({ id }) => [id, id])),
    failed,
    listed: !failed,
    resolved,
  };
}
const options = (listed: HomeList, more: Partial<HomeOptions> & { reached?: string[]; previous?: ListLayout } = {}): HomeOptions => {
  const { reached = [], previous = null, ...rest } = more;
  const at = rest.now ?? now;
  return { now: at, pinnedOnly: false, collapsed: allOpen, projectsFailed: false, opened: null, layout: homeLayout(listed, { now: at, reached }, previous), ...rest };
};
const items = (listed: HomeList, more: Parameters<typeof options>[1] = {}) => homeItems(listed, options(listed, more));

/** A quiet thread in `projectId`, `minutesAgo` old. */
const quiet = (id: string, projectId: string, minutesAgo: number): ThreadSummary => ({
  ...fixtureThreads[0]!,
  id,
  projectId,
  pinnedAt: null,
  unread: false,
  activity: "idle",
  lastActivityAt: now - minutesAgo * 60_000,
});

describe("homeCalls", () => {
  it("names what calls the person in the groups by its row, or by its folded project's label, in the list's order", () => {
    const listed = list();
    const calls = (collapsed: string[]) => homeCalls(items(listed, { collapsed }), listed).map((call) => `${call.id} ${call.status.kind} @ ${call.anchor}`);
    expect(calls(allOpen)).toEqual(["t-pairing waiting @ t-pairing", "t-ledger failed @ t-ledger", "t-docs waiting @ t-docs", "t-phone failed @ t-phone", "t-slack unread @ t-slack"]);
    // Pinned's own unread row is not one of them; folded, a project's calls stand on its label.
    expect(calls([...allOpen, "project:website"]).slice(2, 4)).toEqual(["t-docs waiting @ project:website", "t-phone failed @ project:website"]);
  });
});

describe("homeItems", () => {
  it("gives each label its room as the list is made: a little at the top, none under another label, more after rows", () => {
    const made = items(list());
    const rooms = made.flatMap((item, index) => (item.kind === "section" || item.kind === "project" ? [[made[index - 1]?.kind ?? null, item.room]] : []));
    expect(rooms[0]).toEqual([null, "first"]);
    for (const [before, room] of rooms.slice(1)) expect(room).toBe(before === "section" || before === "project" ? "after-heading" : "after-rows");
    // Some label stands after rows.
    expect(rooms.map(([, room]) => room)).toContain("after-rows");
  });

  it("lists Pinned first, then each project's group in the space's order: its rows newest first by day, then its own Resolved", () => {
    const lines = outline(items(list()));
    expect(lines.slice(0, 3)).toEqual(["§ Pinned 2", "t-notes @ openorc", "t-headline @ openorc"]);
    // Inside its group a row names no project; the Workspace's threads are No project's, last.
    expect(groups(items(list()))).toEqual([
      "# openorc (2)",
      "t-paging",
      "t-pairing",
      "t-ledger",
      // Today's rows lead with no label; a later day's sit under theirs.
      "~ Yesterday",
      "t-settings",
      "# website (2)",
      "t-hero",
      "t-docs",
      "t-phone",
      "# immaculate",
      "t-tokens",
      // Only a project that holds resolved threads ends with the door, folded until the reader opens it.
      "> Resolved folded",
      "# No project",
      "t-slack",
      "t-plan",
    ]);
    // Open, it holds what has been quiet since before yesterday, under its project, naming none.
    const open = groups(items(list(fixtureThreads, { resolvedOpen: ["immaculate"] })));
    expect(open.slice(open.indexOf("# immaculate"), open.indexOf("# No project"))).toEqual(["# immaculate", "t-tokens", "> Resolved", "t-canvas"]);
    expect(lines.filter((line) => line.startsWith("§"))).toEqual(["§ Pinned 2"]);
  });

  it("keeps a project whose threads are all resolved, with its Resolved alone, and folds the door away with its project", () => {
    const old = { ...quiet("old", "website", 0), lastActivityAt: Date.UTC(2026, 8, 1) };
    const listed = list([quiet("o", "openorc", 5), old, { ...old, id: "kept", projectId: WORKSPACE_ID }]);
    expect(groups(items(listed))).toEqual(["# openorc", "o", "# website", "> Resolved folded", "# No project", "> Resolved folded"]);
    expect(groups(items(listed, { collapsed: ["project:website"] }))).toEqual(["# openorc", "o", "# website folded", "# No project", "> Resolved folded"]);
  });

  it("shows a project's four latest threads and every one that is not quiet, then Show N more, which brings ten more", () => {
    const many = [...Array.from({ length: 16 }, (_, index) => quiet(`q-${index}`, "website", 10 + index)), { ...quiet("busy", "website", 200), activity: "running" as const }];
    const listed = list(many);
    expect(groups(items(listed))).toEqual(["# website", "q-0", "q-1", "q-2", "q-3", "busy", "show 12 more"]);
    const reached = ["q-4", "q-5", "q-6", "q-7", "q-8", "q-9", "q-10", "q-11", "q-12", "q-13"];
    // Rows keep the order of their work: the reached ones fall in among the rest.
    expect(groups(items(listed, { reached }))).toEqual(["# website", "q-0", "q-1", "q-2", "q-3", ...reached, "busy", "show 2 more"]);
  });

  it("keeps the projects in the order the day found them while work moves, and puts a project added since on top", () => {
    const two = projects.filter(({ id }) => id === "openorc" || id === "website");
    const first = list([quiet("w", "website", 5), quiet("o", "openorc", 50)], { groups: two });
    const kept = homeLayout(first, { now, reached: [] }, null);
    expect(groups(items(first)).filter((line) => line.startsWith("#"))).toEqual(["# openorc", "# website"]);
    const moved = list([quiet("w", "website", 50), quiet("o", "openorc", 1), quiet("i", "immaculate", 2)]);
    expect(groups(items(moved, { previous: kept })).filter((line) => line.startsWith("#"))).toEqual(["# immaculate", "# openorc", "# website"]);
  });

  it("leaves a cloud project's rows to its label's cloud, which goes out of reach only when none of its threads is reached", () => {
    const cloud = { id: "notes", name: "notes-app", cloud: true as const };
    const hosted = (id: string, reach: "live" | "offline") => ({ ...quiet(id, "notes", 5), owner: { brain: "hosted" as const, reach, heardAt: 1 } });
    const shown = (threads: ThreadSummary[]) => items(list(threads, { groups: [cloud, ...projects] }));
    const label = (all: HomeItem[]) => all.find((item) => item.kind === "project" && item.project.id === "notes");
    const live = shown([hosted("a", "live"), hosted("b", "offline"), quiet("o", "openorc", 5)]);
    expect(
      live
        .filter((item) => item.kind === "thread")
        .map((item) => item.kind === "thread" && [item.thread.id, item.cloudLabel ?? false])
        .sort(),
    ).toEqual([
      ["a", true],
      ["b", true],
      ["o", false],
    ]);
    expect(label(live)).not.toHaveProperty("offline");
    expect(label(shown([hosted("a", "offline"), hosted("b", "offline")]))).toMatchObject({ offline: true });
  });

  it("leaves out a project with nothing in it, unless it is the only one", () => {
    expect(groups(items(list([quiet("o", "openorc", 5)]))).filter((line) => line.startsWith("#"))).toEqual(["# openorc"]);
    const alone = outline(items(list([], { groups: [{ id: "website", name: "website" }] })));
    expect(alone.slice(0, 2)).toEqual(["# website", "no threads yet"]);
    // Not while the threads are still being read, nor where a pin stands.
    expect(outline(homeItems({ ...list([], { groups: [{ id: "website", name: "website" }] }), listed: false }, options(list([]))))).not.toContain("no threads yet");
  });

  it("counts on a label what waits on the person: a question or a failure, never a teammate's ask or an unread result", () => {
    const teammate: ThreadSummary = { ...quiet("shared", "website", 1), activity: "waiting", owner: { brain: "hosted", reach: "live", heardAt: 1, startedBy: { name: "Morgan Reed", image: null } } };
    const unread = { ...quiet("unread", "website", 2), unread: true };
    const failed = { ...quiet("failed", "website", 3), session: { status: "error" as const, message: null } };
    expect(groups(items(list([teammate, unread, failed])))[0]).toBe("# website (1)");
  });

  it("folds a project to the open thread's tree, and rises a project's rows as the reader opens it", () => {
    const listed = list(fixtureThreads, { activeId: "t-docs" });
    const folded = groups(items(listed, { collapsed: [...allOpen, "project:website"], selectedId: "t-docs" }));
    expect(folded.slice(folded.indexOf("# website (2) folded"), folded.indexOf("# immaculate"))).toEqual(["# website (2) folded", "t-docs"]);
    const opened = items(listed, { opened: "project:website" });
    expect(opened.filter((item) => item.kind === "thread" && item.arriving).map((item) => item.key)).toEqual(["t-hero", "t-docs", "t-phone"]);
  });

  it("folds Pinned behind its count, and keeps snoozed threads folded at the foot until opened, each naming its project", () => {
    const snoozed = fixtureThreads.map((thread) => (thread.id === "t-ledger" || thread.id === "t-headline" ? { ...thread, snoozedUntil: now + 3_600_000 } : thread));
    const open = outline(items(list(snoozed)));
    expect(open.slice(0, 2)).toEqual(["§ Pinned 1", "t-notes @ openorc"]);
    expect(open.at(-1)).toBe("§ Snoozed 2 folded");
    const folded = outline(items(list(snoozed), { collapsed: [...allOpen, "pinned:threads", "snoozed-open:threads"] }));
    expect(folded[1]).not.toBe("t-notes @ openorc");
    const snoozedAt = folded.indexOf("§ Snoozed 2");
    expect(folded.slice(snoozedAt)).toEqual(["§ Snoozed 2", "t-ledger @ openorc", "t-headline @ openorc"]);
  });

  it("pages an open Resolved while the host lists more of it, and says so when it holds nothing", () => {
    const many: ThreadSummary[] = Array.from({ length: THREAD_PAGE + 1 }, (_, index) => ({ ...quiet(`w-${index}`, "website", 0), lastActivityAt: Date.UTC(2026, 8, 1) - index }));
    const lines = groups(items(list(many, { limit: THREAD_PAGE, resolvedOpen: ["website"] })));
    expect(lines.slice(0, 3)).toEqual(["# website", "> Resolved", "w-0"]);
    expect(lines.at(-1)).toBe("more resolved");
    // A host that cannot count keeps every door; one opened on nothing says so.
    const uncounted = list([quiet("o", "openorc", 5)], { counted: false, resolvedOpen: ["openorc"], groups: projects.slice(0, 1) });
    expect(groups(items(uncounted))).toEqual(["# openorc", "o", "> Resolved", "no resolved"]);
  });

  it("keeps the open thread's tree under its project while its Resolved is folded, with or without its project", () => {
    const put = fixtureThreads.map((thread) => (thread.id === "t-tokens" ? { ...thread, archivedAt: 1 } : thread));
    const page = (rows: readonly ThreadSummary[], selected: ThreadSummary | null) =>
      sidebarThreadPage({ projectId: WORKSPACE_ID, fetched: rows, selected, filter: "archived" as const, limit: THREAD_PAGE, now });
    const tokens = put.find((thread) => thread.id === "t-tokens")!;
    const base = list(put, { activeId: "t-tokens" });
    const days = sidebarDayList({
      pages: [sidebarThreadPage({ projectId: WORKSPACE_ID, fetched: put, selected: null, filter: "active", limit: 100, now })],
      resolved: page([], tokens),
      pinnedOnly: false,
      activeId: "t-tokens",
      now,
    });
    const held: HomeList = { ...base, days, resolved: (projectId) => (projectId === "immaculate" ? { open: false, roots: [tokens], all: days.all, hasMore: false, pending: false } : null) };
    const open = groups(homeItems(held, options(held, { selectedId: "t-tokens" })));
    expect(open.slice(open.indexOf("# immaculate"), open.indexOf("# No project"))).toEqual(["# immaculate", "> Resolved folded", "t-tokens"]);
    const folded = groups(homeItems(held, options(held, { selectedId: "t-tokens", collapsed: ["project:immaculate"] })));
    expect(folded.slice(folded.indexOf("# immaculate folded"), folded.indexOf("# No project"))).toEqual(["# immaculate folded", "t-tokens"]);
  });

  it("offers a retry where the host could not list its threads, or its projects", () => {
    const lines = outline(items(list(fixtureThreads, { failed: true }), { projectsFailed: true }));
    expect(lines.slice(0, 2)).toEqual(["retry projects", "§ Pinned 2"]);
    expect(lines.at(-1)).toBe("retry threads");
    expect(lines.indexOf("retry threads")).toBeGreaterThan(lines.indexOf("# No project"));
  });

  it("lists only the pinned threads under the pinned filter, with no project and no Resolved", () => {
    expect(outline(items(list(fixtureThreads, { pinnedOnly: true }), { pinnedOnly: true }))).toEqual(["§ Pinned 2", "t-notes @ openorc", "t-headline @ openorc"]);
  });

  it("never lists a row twice when a project's Resolved read still holds one the list shows", () => {
    const listed = list(fixtureThreads, { resolvedOpen: ["immaculate"] });
    const tokens = fixtureThreads.find((thread) => thread.id === "t-tokens")!;
    const stale: HomeList = { ...listed, resolved: (projectId) => (projectId === "immaculate" ? { open: true, roots: [tokens], all: listed.days.all, hasMore: false, pending: false } : null) };
    const keys = homeItems(stale, options(stale)).map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

it("pages each parent's newest children with separate Show more rows, keeps older work and the selection, and ends visible trunks", () => {
  const parent = { ...fixtureThreads[0]!, id: "parent", parentThreadId: null, createdAt: 0 };
  const children = Array.from({ length: 20 }, (_, i): ThreadSummary => ({
    ...parent,
    id: `child-${i}`,
    parentThreadId: parent.id,
    parentRelation: "subagent",
    createdAt: i,
    activity: i === 0 ? "running" : "idle",
  }));
  const nested = Array.from({ length: 8 }, (_, i): ThreadSummary => ({ ...children[0]!, id: `nested-${i}`, parentThreadId: children[19]!.id, createdAt: i, activity: "idle" }));
  const listed = list([parent, ...children, ...nested]);
  const open = { collapsed: [...allOpen, "thread-open:child-19"] };
  const first = items(listed, open);
  expect(first.filter((item) => item.kind === "children-more").map((item) => [item.tree.thread.id, item.count])).toEqual([
    ["child-19", 3],
    ["parent", 14],
  ]);
  const threads = first.filter((item) => item.kind === "thread");
  expect(threads.map((item) => item.thread.id)).toEqual(["parent", "child-19", "nested-7", "nested-6", "nested-5", "nested-4", "nested-3", "child-18", "child-17", "child-16", "child-15", "child-0"]);
  expect(threads.at(-1)?.tree.last).toBe(true);
  // In its group a root names no project, nor does a sub thread anywhere.
  expect(threads.every((item) => item.project === null)).toBe(true);
  expect(
    items(listed, { ...open, childLimits: { parent: 17, "child-19": 17 } })
      .filter((item) => item.kind === "children-more")
      .map((item) => item.count),
  ).toEqual([2]);
  expect(
    items(listed, { selectedId: "nested-0" })
      .filter((item) => item.kind === "thread")
      .map((item) => item.thread.id),
  ).toContain("nested-0");
  expect(items(listed, { collapsed: [...allOpen, "thread-closed:parent"] }).some((item) => item.kind === "children-more")).toBe(false);
});

it("nests children and a grandchild in place, preserving continuation lanes and manual folds", () => {
  const parent = { ...fixtureThreads[0]!, id: "parent", parentThreadId: null };
  const child: ThreadSummary = { ...parent, id: "child", parentThreadId: parent.id, parentRelation: "subagent", createdAt: 1 };
  const grandchild: ThreadSummary = { ...child, id: "grandchild", parentThreadId: child.id, activity: "running" };
  const sibling = { ...child, id: "sibling", createdAt: 2 };
  const listed = list([sibling, grandchild, parent, child]);
  const threads = items(listed).filter((item) => item.kind === "thread");
  expect(threads.map((item) => [item.thread.id, item.tree.depth])).toEqual([
    ["parent", 0],
    ["sibling", 1],
    ["child", 1],
    ["grandchild", 2],
  ]);
  expect(threads[3]!.tree.continuing).toEqual([]);
  expect(threads[1]!.tree.last).toBe(false);
  expect(threads[3]!.tree.last).toBe(true);
  expect(
    items(listed, { collapsed: [...allOpen, "thread-closed:parent"] })
      .filter((item) => item.kind === "thread")
      .map((item) => item.thread.id),
  ).toEqual(["parent"]);
  const finished = list([parent, child, sibling, { ...grandchild, activity: "idle" }]);
  expect(items(finished).filter((item) => item.kind === "thread")).toHaveLength(1);
});
