import { sidebarDayList, sidebarThreadPage, THREAD_PAGE, type ListLayout, type SidebarFilter } from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { homeCalls, homeItems, homeLayout, type HomeItem, type HomeList, type HomeOptions, type HomeProject } from "./home-items";
import { fixtureProjects, fixtureThreads } from "./test-fixtures/threads";

const outline = (items: HomeItem[]) =>
  items.map((item) => {
    if (item.kind === "section") return `§ ${item.label}${item.count === undefined ? "" : ` ${item.count}`}${item.open ? "" : " folded"}`;
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
  return lines.slice(
    lines.findIndex((line) => line.startsWith("#")),
    lines.findIndex((line) => line.startsWith("§ Snoozed") || line.startsWith("§ Resolved")),
  );
};

const now = Date.UTC(2026, 9, 23, 12);
const names = new Map([[WORKSPACE_ID, "Workspace"], ...fixtureProjects.map(({ id, name }): [string, string] => [id, name])]);
const projects: HomeProject[] = [...fixtureProjects.map(({ id, name }) => ({ id, name })), { id: WORKSPACE_ID, name: "No project" }];
/** Resolved open, so tests about something else see every row. */
const allOpen = ["resolved-open:threads"];

/** What a host's lists give Home: one page across projects, newest work first, and every pin from its own read. */
function list(
  threads: readonly ThreadSummary[] = fixtureThreads,
  more: { pinnedOnly?: boolean; limit?: number; failed?: boolean; activeId?: string; at?: number; groups?: HomeProject[] } = {},
): HomeList {
  const { pinnedOnly = false, limit = 100, failed = false, activeId, at = now, groups: shown = projects } = more;
  const sorted = threads.filter((thread) => !pinnedOnly || thread.pinnedAt).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const page = (filter: SidebarFilter, rows: readonly ThreadSummary[], count: number) => sidebarThreadPage({ projectId: WORKSPACE_ID, fetched: rows, selected: null, filter, limit: count, now: at });
  const pins = pinnedOnly
    ? undefined
    : page(
        "active",
        sorted.filter((thread) => thread.pinnedAt),
        Number.MAX_SAFE_INTEGER,
      );
  const resolved = pinnedOnly ? undefined : page("archived", sorted, limit);
  return {
    days: sidebarDayList({ pages: [page("active", sorted, limit)], pins, resolved, pinnedOnly, activeId, now: at }),
    names,
    groups: shown,
    groupOf: new Map(shown.map(({ id }) => [id, id])),
    failed,
    listed: !failed,
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
  it("lists Pinned first, then each project's group in the space's order with the rest newest first, then Snoozed and Resolved", () => {
    const lines = outline(items(list()));
    expect(lines.slice(0, 3)).toEqual(["§ Pinned 2", "t-notes @ openorc", "t-headline @ openorc"]);
    // Inside its group a row names no project; the Workspace's threads are No project's, last.
    expect(groups(items(list()))).toEqual([
      "# openorc (2)",
      "t-paging",
      "t-pairing",
      "t-ledger",
      "t-settings",
      "# website (2)",
      "t-hero",
      "t-docs",
      "t-phone",
      "# immaculate",
      "t-tokens",
      "# No project",
      "t-slack",
      "t-plan",
    ]);
    // Resolved, open here, holds what has been quiet since before yesterday, each row naming its project.
    expect(lines.slice(-2)).toEqual(["§ Resolved", "t-canvas @ immaculate"]);
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
    expect(open[open.indexOf("§ Resolved") - 1]).toBe("§ Snoozed 2 folded");
    const folded = outline(items(list(snoozed), { collapsed: [...allOpen, "pinned:threads", "snoozed-open:threads"] }));
    expect(folded[1]).not.toBe("t-notes @ openorc");
    const snoozedAt = folded.indexOf("§ Snoozed 2");
    expect(folded.slice(snoozedAt, snoozedAt + 4)).toEqual(["§ Snoozed 2", "t-ledger @ openorc", "t-headline @ openorc", "§ Resolved"]);
  });

  it("shows more in Resolved while the host lists more, and names no count on it", () => {
    const many: ThreadSummary[] = Array.from({ length: THREAD_PAGE + 1 }, (_, index) => ({ ...quiet(`w-${index}`, WORKSPACE_ID, 0), lastActivityAt: Date.UTC(2026, 8, 1) - index }));
    const lines = outline(homeItems({ ...list(many, { limit: THREAD_PAGE }), resolvedCount: 120 }, options(list(many, { limit: THREAD_PAGE }))));
    expect(lines[0]).toBe("§ Resolved");
    expect(lines[1]).toBe("w-0 @ Workspace");
    expect(lines.at(-1)).toBe("more");
    expect(outline(items(list(many, { limit: THREAD_PAGE }), { collapsed: [] })).at(-1)).toBe("§ Resolved folded");
  });

  it("offers a retry where the host could not list its threads, or its projects", () => {
    const lines = outline(items(list(fixtureThreads, { failed: true }), { projectsFailed: true }));
    expect(lines.slice(0, 2)).toEqual(["retry projects", "§ Pinned 2"]);
    expect(lines.indexOf("retry threads")).toBeGreaterThan(lines.indexOf("# No project"));
    expect(lines.indexOf("retry threads")).toBeLessThan(lines.indexOf("§ Resolved"));
  });

  it("lists only the pinned threads under the pinned filter, and puts the resolved ones in Resolved at the foot", () => {
    expect(outline(items(list(fixtureThreads, { pinnedOnly: true }), { pinnedOnly: true }))).toEqual(["§ Pinned 2", "t-notes @ openorc", "t-headline @ openorc"]);
    const resolved = fixtureThreads.map((thread) => (thread.projectId === "website" ? { ...thread, archivedAt: 1, pinnedAt: null } : thread));
    const lines = outline(items(list(resolved)));
    expect(lines).not.toContain("# website");
    const website = lines.flatMap((line, index) => (line.endsWith("@ website") ? [index] : []));
    expect(website).toHaveLength(3);
    expect(website.every((index) => index > lines.indexOf("§ Resolved"))).toBe(true);
  });

  it("leaves Resolved out once the host says it holds nothing, and keeps it while the host has not said", () => {
    const current = fixtureThreads.map((thread) => ({ ...thread, archivedAt: null, lastActivityAt: now }));
    expect(outline(homeItems({ ...list(current), resolvedCount: 0 }, options(list(current)))).filter((line) => line.startsWith("§ Resolved"))).toEqual([]);
    expect(outline(items(list(current))).at(-1)).toBe("§ Resolved");
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
