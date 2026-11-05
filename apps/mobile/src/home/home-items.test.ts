import { THREAD_PAGE } from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { homeItems, homeWaiting, owned, type HomeItem, type HomeOptions, type ProjectThreads } from "./home-items";
import { newThreadRoute } from "./out-of-reach";
import { fixtureProjects, fixtureThreads } from "./test-fixtures/threads";

const outline = (items: HomeItem[]) =>
  items.map((item) => {
    if (item.kind === "heading") return `# ${item.title} (${item.meta?.text ?? "…"})${item.projectId && !item.open ? " folded" : ""}`;
    if (item.kind === "section") return `${item.fold} ${item.count}${item.open ? "" : " folded"}`;
    if (item.kind === "children-more") return `more ${item.count} in ${item.tree.thread.id}`;
    if (item.kind === "more") return `more ${item.projectId}`;
    if (item.kind === "retry") return `retry ${item.projectId ?? "projects"}`;
    return item.project ? `${item.thread.id} @ ${item.project}` : item.thread.id;
  });

const groups = (threads = fixtureThreads, projects = fixtureProjects): ProjectThreads[] =>
  [{ id: WORKSPACE_ID, name: "Workspace" }, ...projects].map(({ id, name }) => ({ id, name, threads: threads.filter((thread) => thread.projectId === id), limit: THREAD_PAGE, failed: false }));
const now = Date.UTC(2026, 9, 23, 12);
const options = (more: Partial<HomeOptions> = {}): HomeOptions => ({ now, filter: "active", pinnedOnly: false, collapsed: [], waiting: [], projectsFailed: false, opened: null, ...more });

describe("homeItems", () => {
  it("lists waiting threads first across projects, then Workspace and each project with pins ahead", () => {
    expect(outline(homeItems(groups(), options()))).toEqual([
      "# Needs you (2)",
      "t-pairing @ openorc",
      "t-docs @ website",
      "# Workspace (2 threads)",
      "t-plan",
      "t-slack",
      "# openorc (Needs you)",
      "pinned 2",
      "t-headline",
      "t-notes",
      "t-paging",
      "t-ledger",
      "t-settings",
      "# website (Needs you)",
      "t-hero",
      "t-phone",
      "# immaculate (2 threads)",
      "t-tokens",
      "t-canvas",
    ]);
  });

  it("keeps a project heading when it lists nothing, says nothing about counts while loading, and omits Needs you when nothing waits", () => {
    const idle = fixtureThreads.filter((thread) => thread.activity !== "waiting" && thread.projectId === WORKSPACE_ID);
    const loading: ProjectThreads = { id: "website", name: "website", threads: undefined, limit: THREAD_PAGE, failed: false };
    expect(outline(homeItems([...groups(idle, [fixtureProjects[2]!]), loading], options()))).toEqual(["# Workspace (2 threads)", "t-plan", "t-slack", "# immaculate (No threads)", "# website (…)"]);
  });

  it("starts a thread from a project's heading, but not from Needs you", () => {
    const headings = homeItems(groups(), options()).filter((item) => item.kind === "heading");
    expect(headings.map((item) => item.projectId)).toEqual([null, WORKSPACE_ID, "openorc", "website", "immaculate"]);
  });

  it("shows a page of threads and Show more while the Mac lists more, then the next page", () => {
    const many: ThreadSummary[] = Array.from({ length: THREAD_PAGE + 3 }, (_, index) => ({ ...fixtureThreads[1]!, id: `w-${index}`, lastActivityAt: now - index }));
    const workspace = (limit: number): ProjectThreads[] => [{ id: WORKSPACE_ID, name: "Workspace", threads: many.slice(0, limit + 1), limit, failed: false }];
    const first = outline(homeItems(workspace(THREAD_PAGE), options()));
    expect(first).toHaveLength(1 + THREAD_PAGE + 1);
    expect(first.at(-1)).toBe(`more ${WORKSPACE_ID}`);
    expect(first[0]).toBe(`# Workspace (${THREAD_PAGE}+ threads)`);
    const second = outline(homeItems(workspace(THREAD_PAGE * 2), options()));
    expect(second).toEqual([`# Workspace (${THREAD_PAGE + 3} threads)`, ...many.map((thread) => thread.id)]);
  });

  it("folds a project to its heading and keeps its meta, while what waits in it stays under Needs you", () => {
    expect(outline(homeItems(groups(), options({ collapsed: ["project:openorc", "pinned:website"] }))).slice(0, 10)).toEqual([
      "# Needs you (2)",
      "t-pairing @ openorc",
      "t-docs @ website",
      "# Workspace (2 threads)",
      "t-plan",
      "t-slack",
      "# openorc (Needs you) folded",
      "# website (Needs you)",
      "t-hero",
      "t-phone",
    ]);
  });

  it("folds pinned threads behind their count, and keeps snoozed ones folded at the foot until opened", () => {
    const snoozed = fixtureThreads.map((thread) => (thread.id === "t-ledger" || thread.id === "t-headline" ? { ...thread, snoozedUntil: now + 3_600_000 } : thread));
    const openorc = (collapsed: string[]) => {
      const items = outline(homeItems(groups(snoozed), options({ collapsed })));
      return items.slice(items.indexOf("# openorc (Needs you)") + 1, items.indexOf("# website (Needs you)"));
    };
    expect(openorc([])).toEqual(["pinned 1", "t-notes", "t-paging", "t-settings", "snoozed 2 folded"]);
    expect(openorc(["pinned:openorc", "snoozed-open:openorc"])).toEqual(["pinned 1 folded", "t-paging", "t-settings", "snoozed 2", "t-headline", "t-ledger"]);
  });

  it("puts a waiting thread the inbox knows about under Needs you, even past the loaded page, once", () => {
    const elsewhere = { ...fixtureThreads[0]!, id: "t-far", projectId: "immaculate", title: "Old question", activity: "waiting" as const, lastActivityAt: now };
    const items = outline(homeItems(groups(), options({ waiting: [elsewhere, fixtureThreads.find((thread) => thread.id === "t-docs")!, { ...elsewhere, id: "t-gone", archivedAt: 1 }] })));
    expect(items.slice(0, 4)).toEqual(["# Needs you (3)", "t-far @ immaculate", "t-pairing @ openorc", "t-docs @ website"]);
  });

  it("puts a waiting thread just past a page's end under Needs you, though the inbox leaves it to the list that read it", () => {
    const many: ThreadSummary[] = Array.from({ length: THREAD_PAGE + 1 }, (_, index) => ({ ...fixtureThreads[1]!, id: `w-${index}`, lastActivityAt: now - index }));
    many[THREAD_PAGE] = { ...many[THREAD_PAGE]!, activity: "waiting" };
    const items = outline(homeItems([{ id: WORKSPACE_ID, name: "Workspace", threads: many, limit: THREAD_PAGE, failed: false }], options()));
    expect(items.slice(0, 2)).toEqual(["# Needs you (1)", `w-${THREAD_PAGE} @ Workspace`]);
    expect(items.at(-1)).toBe(`more ${WORKSPACE_ID}`);
  });

  it("offers a retry where the Mac could not list a project's threads, or its projects", () => {
    const failing = groups().map((group) => (group.id === "immaculate" ? { ...group, threads: undefined, failed: true } : group));
    const items = outline(homeItems(failing, options({ projectsFailed: true })));
    expect(items.slice(3, 5)).toEqual(["retry projects", "# Workspace (2 threads)"]);
    expect(items.slice(-2)).toEqual(["# immaculate (…)", "retry immaculate"]);
  });

  it("rises in only the rows of the project the reader just opened", () => {
    const items = homeItems(groups(), options({ opened: "immaculate" }));
    expect(items.filter((item) => item.kind === "thread" && item.arriving).map((item) => item.key)).toEqual(["t-tokens", "t-canvas"]);
  });

  it("lists only the pinned threads, or the archive with nothing under Needs you, or orcmode's projects without Show more", () => {
    expect(outline(homeItems(groups(), options({ pinnedOnly: true }))).filter((line) => !line.startsWith("#"))).toEqual([
      "t-pairing @ openorc",
      "t-docs @ website",
      "pinned 2",
      "t-headline",
      "t-notes",
    ]);
    const archived = fixtureThreads.map((thread) => ({ ...thread, archivedAt: 1 })).filter((thread) => thread.projectId === "website");
    expect(outline(homeItems(groups(archived), options({ filter: "archived" })))).toEqual([
      "# Workspace (No threads)",
      "# openorc (No threads)",
      "# website (Needs you)",
      "t-hero",
      "t-docs",
      "t-phone",
      "# immaculate (No threads)",
    ]);
    const many: ThreadSummary[] = Array.from({ length: THREAD_PAGE + 3 }, (_, index) => ({ ...fixtureThreads[1]!, id: `w-${index}`, unread: true, lastActivityAt: now - index }));
    const orc = outline(homeItems([{ id: WORKSPACE_ID, name: "Workspace", threads: many, limit: THREAD_PAGE, failed: false }, ...groups([]).slice(1)], options({ filter: "orc" })));
    expect(orc[0]).toBe(`# Workspace (${THREAD_PAGE}+ threads)`);
    expect(orc).toHaveLength(1 + THREAD_PAGE);
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
  const listed = groups([parent, ...children, ...nested], []);
  const open = { collapsed: ["thread-open:child-19"] };
  const first = homeItems(listed, options(open));
  expect(first.filter((item) => item.kind === "children-more").map((item) => [item.tree.thread.id, item.count])).toEqual([
    ["child-19", 3],
    ["parent", 14],
  ]);
  const rows = first.filter((item) => item.kind === "thread");
  expect(rows.map((item) => item.thread.id)).toEqual(["parent", "child-19", "nested-7", "nested-6", "nested-5", "nested-4", "nested-3", "child-18", "child-17", "child-16", "child-15", "child-0"]);
  expect(rows.at(-1)?.tree.last).toBe(true);
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
  expect(homeItems(listed, options({ collapsed: ["thread-closed:parent"] })).some((item) => item.kind === "children-more")).toBe(false);
});

it("nests children and a grandchild in place, preserving continuation lanes and manual folds", () => {
  const parent = { ...fixtureThreads[0]!, id: "parent", parentThreadId: null };
  const child: ThreadSummary = { ...parent, id: "child", parentThreadId: parent.id, parentRelation: "subagent", createdAt: 1 };
  const grandchild: ThreadSummary = { ...child, id: "grandchild", parentThreadId: child.id, activity: "running" };
  const sibling = { ...child, id: "sibling", createdAt: 2 };
  const listed = groups([sibling, grandchild, parent, child], []);
  const rows = homeItems(listed, options()).filter((item) => item.kind === "thread");
  expect(rows.map((item) => [item.thread.id, item.tree.depth])).toEqual([
    ["parent", 0],
    ["sibling", 1],
    ["child", 1],
    ["grandchild", 2],
  ]);
  expect(rows[3]!.tree.continuing).toEqual([]);
  expect(rows[1]!.tree.last).toBe(false);
  expect(rows[3]!.tree.last).toBe(true);
  expect(
    homeItems(listed, options({ collapsed: ["thread-closed:parent"] }))
      .filter((item) => item.kind === "thread")
      .map((item) => item.thread.id),
  ).toEqual(["parent"]);
  const finished = groups([parent, child, sibling, { ...grandchild, activity: "idle" }], []);
  expect(homeItems(finished, options()).filter((item) => item.kind === "thread")).toHaveLength(1);
});

it("lists the waiting child itself in Needs you even when its parent and project are folded", () => {
  const parent = { ...fixtureThreads[0]!, id: "parent", parentThreadId: null };
  const child: ThreadSummary = { ...parent, id: "child", parentThreadId: parent.id, parentRelation: "started", activity: "waiting" };
  const listed = homeItems(groups([], []), options({ waiting: [child, parent], collapsed: [`project:${WORKSPACE_ID}`, "thread-closed:parent"] }));
  expect(listed.filter((item) => item.kind === "thread").map((item) => [item.thread.id, item.tree.depth])).toEqual([["child", 0]]);
});

describe("Needs you beside a partner host", () => {
  const cloud = { ...fixtureThreads.find((thread) => thread.id === "t-hero")!, id: "c-review", activity: "waiting" as const, lastActivityAt: Date.UTC(2026, 9, 23, 11, 59) };

  it("lists the partner's waiting threads with the shown host's, newest first, each keyed and marked by its host", () => {
    const items = homeItems(groups(), options({ partnerWaiting: [{ thread: cloud, project: "openorc", host: "brain" }] }));
    expect(outline(items).slice(0, 4)).toEqual(["# Needs you (3)", "c-review @ openorc", "t-pairing @ openorc", "t-docs @ website"]);
    expect(items.find((item) => item.kind === "thread" && item.thread.id === "c-review")).toMatchObject({ key: "brain:c-review", host: "brain" });
  });

  it("lists a thread that just came here from the partner once, as this host's, while the partner's last list still has it", () => {
    const moved = { ...cloud, id: "t-hero" };
    const items = homeItems(groups(), options({ partnerWaiting: [{ thread: moved, project: "website", host: "brain" }] }));
    expect(items.filter((item) => item.kind === "thread" && item.thread.id === "t-hero").map((item) => item.key)).toEqual(["t-hero"]);
  });

  it("leaves a partner's own list without Needs you, its waiting threads out of its projects, and hands them over", () => {
    const partner = homeItems(groups(), options({ waitingShownElsewhere: true }));
    expect(outline(partner)).not.toContain("# Needs you (2)");
    expect(outline(partner).flat()).not.toContain("t-pairing");
    expect(homeWaiting(groups(), options()).map(({ thread, project }) => `${thread.id} @ ${project}`)).toEqual(["t-pairing @ openorc", "t-docs @ website"]);
    expect(homeWaiting(groups(), options({ filter: "archived" }))).toEqual([]);
  });
});

describe("owned", () => {
  const away = { brain: "mac", reach: "offline", heardAt: 1 } as const;
  const partner = { brain: "cloud", reach: "live", heardAt: 1 } as const;

  it("marks a host's rows and its project headings, never Needs you's heading or a partner's row listed there", () => {
    const items = homeItems(groups(), options({ partnerWaiting: [{ thread: { ...fixtureThreads[0]!, id: "cloud-1", activity: "waiting", owner: partner }, project: "openorc", host: "brain-1" }] }));
    const marked = owned(items, away);
    const headings = marked.flatMap((item) => (item.kind === "heading" ? [[item.title, item.owner?.reach ?? null]] : []));
    const rows = marked.flatMap((item) => (item.kind === "thread" ? [[item.thread.id, item.thread.owner?.reach ?? null]] : []));
    expect(headings).toEqual([
      ["Needs you", null],
      ["Workspace", "offline"],
      ["openorc", "offline"],
      ["website", "offline"],
      ["immaculate", "offline"],
    ]);
    expect(rows.filter(([, reach]) => reach !== "offline")).toEqual([["cloud-1", "live"]]);
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
