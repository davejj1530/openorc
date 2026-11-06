import { sidebarDayList, sidebarThreadPage, THREAD_PAGE, type SidebarFilter } from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { homeItems, homeWaiting, owned, type HomeItem, type HomeList, type HomeOptions } from "./home-items";
import { newThreadRoute } from "./out-of-reach";
import { fixtureProjects, fixtureThreads } from "./test-fixtures/threads";

const outline = (items: HomeItem[]) =>
  items.map((item) => {
    if (item.kind === "heading") return `# ${item.title} (${item.count})`;
    if (item.kind === "section") return `§ ${item.label}${item.count === undefined ? "" : ` ${item.count}`}${item.open ? "" : " folded"}`;
    if (item.kind === "children-more") return `more ${item.count} in ${item.tree.thread.id}`;
    if (item.kind === "more") return "more";
    if (item.kind === "retry") return `retry ${item.projects ? "projects" : "threads"}`;
    return item.project ? `${item.thread.id} @ ${item.project}` : item.thread.id;
  });
/** The rows alone, where which day a fixture falls in depends on the machine's time zone. */
const rows = (items: HomeItem[]) => outline(items).filter((line) => !line.startsWith("§"));

const now = Date.UTC(2026, 9, 23, 12);
const names = new Map([[WORKSPACE_ID, "Workspace"], ...fixtureProjects.map(({ id, name }): [string, string] => [id, name])]);
/** Every day open, so tests about something else see every row whatever the time zone. */
const allOpen = ["day-open:yesterday", "day-open:week", "day-open:older"];

/** What a host's lists give Home: one page across projects, newest work first, and every pin from its own read. */
function list(
  threads: readonly ThreadSummary[] = fixtureThreads,
  more: { filter?: SidebarFilter; pinnedOnly?: boolean; limit?: number; failed?: boolean; activeId?: string; at?: number } = {},
): HomeList {
  const { filter = "active", pinnedOnly = false, limit = 100, failed = false, activeId, at = now } = more;
  const sorted = threads.filter((thread) => !pinnedOnly || thread.pinnedAt).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const page = sidebarThreadPage({ projectId: WORKSPACE_ID, fetched: sorted, selected: null, filter, limit, now: at });
  const pinned = sorted.filter((thread) => thread.pinnedAt);
  const pins = filter === "active" && !pinnedOnly ? sidebarThreadPage({ projectId: WORKSPACE_ID, fetched: pinned, selected: null, filter, limit: Number.MAX_SAFE_INTEGER, now: at }) : undefined;
  return { days: sidebarDayList({ pages: [page], pins, pinnedOnly, activeId, now: at }), names, read: sorted, failed };
}
const options = (more: Partial<HomeOptions> = {}): HomeOptions => ({ now, filter: "active", pinnedOnly: false, collapsed: allOpen, waiting: [], projectsFailed: false, opened: null, ...more });

describe("homeItems", () => {
  it("lists what waits on you first across projects, then pins, then the rest newest first, each row naming its project", () => {
    const items = homeItems(list(), options());
    expect(rows(items)).toEqual([
      "# Needs you (2)",
      "t-pairing @ openorc",
      "t-docs @ website",
      "t-notes @ openorc",
      "t-headline @ openorc",
      "t-paging @ openorc",
      "t-hero @ website",
      "t-slack @ Workspace",
      "t-ledger @ openorc",
      "t-plan @ Workspace",
      "t-phone @ website",
      "t-tokens @ immaculate",
      "t-settings @ openorc",
      "t-canvas @ immaculate",
    ]);
    expect(outline(items)[3]).toBe("§ Pinned 2");
  });

  it("groups the rest into the last hours, then by local calendar day folded past today, keeping the open thread", () => {
    const at = new Date(2026, 9, 23, 20).getTime();
    const base = { ...fixtureThreads[0]!, pinnedAt: null };
    const threads = [
      { ...base, id: "a", lastActivityAt: new Date(2026, 9, 23, 19).getTime() },
      { ...base, id: "e", lastActivityAt: new Date(2026, 9, 23, 10).getTime() },
      { ...base, id: "b", lastActivityAt: new Date(2026, 9, 22, 10).getTime() },
      { ...base, id: "c", lastActivityAt: new Date(2026, 9, 20, 10).getTime() },
      { ...base, id: "d", lastActivityAt: new Date(2026, 9, 1, 10).getTime() },
    ];
    expect(outline(homeItems(list(threads, { at }), options({ now: at, collapsed: [] })))).toEqual([
      "§ Recent",
      "a @ Workspace",
      "§ Today",
      "e @ Workspace",
      "§ Yesterday folded",
      "§ Last 7 days folded",
      "§ Older folded",
    ]);
    expect(outline(homeItems(list(threads, { at, activeId: "d" }), options({ now: at, collapsed: [], selectedId: "d" }))).slice(-2)).toEqual(["§ Older folded", "d @ Workspace"]);
    const opened = homeItems(list(threads, { at }), options({ now: at, collapsed: ["day-open:week"], opened: "day-open:week" }));
    expect(opened.filter((item) => item.kind === "thread" && item.arriving).map((item) => item.key)).toEqual(["c"]);
  });

  it("folds Pinned behind its count, and keeps snoozed threads folded at the foot until opened", () => {
    const snoozed = fixtureThreads.map((thread) => (thread.id === "t-ledger" || thread.id === "t-headline" ? { ...thread, snoozedUntil: now + 3_600_000 } : thread));
    const open = outline(homeItems(list(snoozed), options()));
    expect(open.slice(open.indexOf("§ Pinned 1"), open.indexOf("§ Pinned 1") + 2)).toEqual(["§ Pinned 1", "t-notes @ openorc"]);
    expect(open.at(-1)).toBe("§ Snoozed 2 folded");
    const folded = outline(homeItems(list(snoozed), options({ collapsed: [...allOpen, "pinned:threads", "snoozed-open:threads"] })));
    expect(folded[folded.indexOf("§ Pinned 1 folded") + 1]).not.toBe("t-notes @ openorc");
    expect(folded.slice(-3)).toEqual(["§ Snoozed 2", "t-ledger @ openorc", "t-headline @ openorc"]);
  });

  it("puts a waiting thread the inbox knows about under Needs you, even past the loaded page, once", () => {
    const elsewhere = { ...fixtureThreads[0]!, id: "t-far", projectId: "immaculate", title: "Old question", activity: "waiting" as const, lastActivityAt: now };
    const items = rows(homeItems(list(), options({ waiting: [elsewhere, fixtureThreads.find((thread) => thread.id === "t-docs")!, { ...elsewhere, id: "t-gone", archivedAt: 1 }] })));
    expect(items.slice(0, 4)).toEqual(["# Needs you (3)", "t-far @ immaculate", "t-pairing @ openorc", "t-docs @ website"]);
  });

  it("puts a waiting thread just past a page's end under Needs you, and shows more in Older while the host lists more", () => {
    const many: ThreadSummary[] = Array.from({ length: THREAD_PAGE + 1 }, (_, index) => ({ ...fixtureThreads[1]!, id: `w-${index}`, unread: false, lastActivityAt: Date.UTC(2026, 8, 1) - index }));
    many[THREAD_PAGE] = { ...many[THREAD_PAGE]!, activity: "waiting" };
    const items = outline(homeItems(list(many, { limit: THREAD_PAGE }), options()));
    expect(items.slice(0, 2)).toEqual(["# Needs you (1)", `w-${THREAD_PAGE} @ Workspace`]);
    expect(items.slice(2, 4)).toEqual(["§ Older", "w-0 @ Workspace"]);
    expect(items.at(-1)).toBe("more");
    expect(outline(homeItems(list(many, { limit: THREAD_PAGE }), options({ collapsed: [] }))).at(-1)).toBe("§ Older folded");
  });

  it("offers a retry where the host could not list its threads, or its projects", () => {
    const items = outline(homeItems(list(fixtureThreads, { failed: true }), options({ projectsFailed: true })));
    expect(items.slice(3, 5)).toEqual(["retry projects", "§ Pinned 2"]);
    expect(items.at(-1)).toBe("retry threads");
  });

  it("lists only the pinned threads, or the archive with nothing under Needs you", () => {
    expect(outline(homeItems(list(fixtureThreads, { pinnedOnly: true }), options({ pinnedOnly: true })))).toEqual(["§ Pinned 2", "t-notes @ openorc", "t-headline @ openorc"]);
    const archived = fixtureThreads.map((thread) => ({ ...thread, archivedAt: 1 })).filter((thread) => thread.projectId === "website");
    expect(rows(homeItems(list(archived, { filter: "archived" }), options({ filter: "archived" })))).toEqual(["t-hero @ website", "t-docs @ website", "t-phone @ website"]);
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
  const first = homeItems(listed, options(open));
  expect(first.filter((item) => item.kind === "children-more").map((item) => [item.tree.thread.id, item.count])).toEqual([
    ["child-19", 3],
    ["parent", 14],
  ]);
  const threads = first.filter((item) => item.kind === "thread");
  expect(threads.map((item) => item.thread.id)).toEqual(["parent", "child-19", "nested-7", "nested-6", "nested-5", "nested-4", "nested-3", "child-18", "child-17", "child-16", "child-15", "child-0"]);
  expect(threads.at(-1)?.tree.last).toBe(true);
  expect(threads[0]).toMatchObject({ project: "Workspace" });
  expect(threads[1]).toMatchObject({ project: null });
  expect(
    homeItems(listed, options({ ...open, childLimits: { parent: 17, "child-19": 17 } }))
      .filter((item) => item.kind === "children-more")
      .map((item) => item.count),
  ).toEqual([2]);
  expect(
    homeItems(listed, options({ selectedId: "nested-0" }))
      .filter((item) => item.kind === "thread")
      .map((item) => item.thread.id),
  ).toContain("nested-0");
  expect(homeItems(listed, options({ collapsed: [...allOpen, "thread-closed:parent"] })).some((item) => item.kind === "children-more")).toBe(false);
});

it("nests children and a grandchild in place, preserving continuation lanes and manual folds", () => {
  const parent = { ...fixtureThreads[0]!, id: "parent", parentThreadId: null };
  const child: ThreadSummary = { ...parent, id: "child", parentThreadId: parent.id, parentRelation: "subagent", createdAt: 1 };
  const grandchild: ThreadSummary = { ...child, id: "grandchild", parentThreadId: child.id, activity: "running" };
  const sibling = { ...child, id: "sibling", createdAt: 2 };
  const listed = list([sibling, grandchild, parent, child]);
  const threads = homeItems(listed, options()).filter((item) => item.kind === "thread");
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
    homeItems(listed, options({ collapsed: [...allOpen, "thread-closed:parent"] }))
      .filter((item) => item.kind === "thread")
      .map((item) => item.thread.id),
  ).toEqual(["parent"]);
  const finished = list([parent, child, sibling, { ...grandchild, activity: "idle" }]);
  expect(homeItems(finished, options()).filter((item) => item.kind === "thread")).toHaveLength(1);
});

it("lists the waiting child itself in Needs you even when its parent and its day are folded", () => {
  const parent = { ...fixtureThreads[0]!, id: "parent", parentThreadId: null };
  const child: ThreadSummary = { ...parent, id: "child", parentThreadId: parent.id, parentRelation: "started", activity: "waiting" };
  const listed = homeItems(list([]), options({ waiting: [child, parent], collapsed: ["day-closed:today", "thread-closed:parent"] }));
  expect(listed.filter((item) => item.kind === "thread").map((item) => [item.thread.id, item.tree.depth])).toEqual([["child", 0]]);
});

describe("Needs you beside a partner host", () => {
  const cloud = { ...fixtureThreads.find((thread) => thread.id === "t-hero")!, id: "c-review", activity: "waiting" as const, lastActivityAt: Date.UTC(2026, 9, 23, 11, 59) };

  it("lists the partner's waiting threads with the shown host's, newest first, each keyed and marked by its host", () => {
    const items = homeItems(list(), options({ partnerWaiting: [{ thread: cloud, project: "openorc", host: "brain" }] }));
    expect(outline(items).slice(0, 4)).toEqual(["# Needs you (3)", "c-review @ openorc", "t-pairing @ openorc", "t-docs @ website"]);
    expect(items.find((item) => item.kind === "thread" && item.thread.id === "c-review")).toMatchObject({ key: "brain:c-review", host: "brain" });
  });

  it("lists a thread that just came here from the partner once, as this host's, while the partner's last list still has it", () => {
    const moved = { ...cloud, id: "t-hero" };
    const items = homeItems(list(), options({ partnerWaiting: [{ thread: moved, project: "website", host: "brain" }] }));
    expect(items.filter((item) => item.kind === "thread" && item.thread.id === "t-hero").map((item) => item.key)).toEqual(["t-hero"]);
  });

  it("leaves a partner's own list without Needs you, its waiting threads out of its days, and hands them over", () => {
    const partner = outline(homeItems(list(), options({ waitingShownElsewhere: true })));
    expect(partner).not.toContain("# Needs you (2)");
    expect(partner.some((line) => line.startsWith("t-pairing"))).toBe(false);
    expect(homeWaiting(list(), options()).map(({ thread, project }) => `${thread.id} @ ${project}`)).toEqual(["t-pairing @ openorc", "t-docs @ website"]);
    expect(homeWaiting(list(), options({ filter: "archived" }))).toEqual([]);
  });
});

describe("owned", () => {
  const away = { brain: "mac", reach: "offline", heardAt: 1 } as const;
  const partner = { brain: "cloud", reach: "live", heardAt: 1 } as const;

  it("marks a host's rows, never a partner's row listed under its Needs you", () => {
    const items = homeItems(list(), options({ partnerWaiting: [{ thread: { ...fixtureThreads[0]!, id: "cloud-1", activity: "waiting", owner: partner }, project: "openorc", host: "brain-1" }] }));
    const marked = owned(items, away).flatMap((item) => (item.kind === "thread" ? [[item.thread.id, item.thread.owner?.reach ?? null]] : []));
    expect(marked.filter(([, reach]) => reach !== "offline")).toEqual([["cloud-1", "live"]]);
  });
});

describe("newThreadRoute", () => {
  it("opens New thread on the cloud brain while the shown Mac is out of reach, else on the shown host", () => {
    expect(newThreadRoute({ brain: "mac", reach: "offline", heardAt: 1 }, "brain-1")).toEqual({ pathname: "/new", params: { host: "brain-1" } });
    expect(newThreadRoute(null, "brain-1")).toBe("/new");
    expect(newThreadRoute({ brain: "cloud", reach: "asleep", heardAt: 1 }, "mac-1")).toBe("/new");
    expect(newThreadRoute({ brain: "mac", reach: "offline", heardAt: 1 }, null)).toBe("/new");
  });
});
