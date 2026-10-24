import { THREAD_PAGE } from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { homeItems, type HomeItem, type HomeOptions, type ProjectThreads } from "./home-items";
import { fixtureProjects, fixtureThreads } from "./test-fixtures/threads";

const outline = (items: HomeItem[]) =>
  items.map((item) => {
    if (item.kind === "heading") return `# ${item.title} (${item.meta?.text ?? "…"})${item.projectId && !item.open ? " folded" : ""}`;
    if (item.kind === "section") return `${item.fold} ${item.count}${item.open ? "" : " folded"}`;
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
