import { THREAD_PAGE } from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { homeItems, type HomeItem, type ProjectThreads } from "./home-items";
import { fixtureProjects, fixtureThreads } from "./test-fixtures/threads";

const outline = (items: HomeItem[]) =>
  items.map((item) => {
    if (item.kind === "heading") return `# ${item.title} (${item.meta?.text ?? "…"})`;
    if (item.kind === "pinned") return `pinned ${item.count}`;
    if (item.kind === "more") return `more ${item.projectId}`;
    return item.project ? `${item.thread.id} @ ${item.project}` : item.thread.id;
  });

const groups = (threads = fixtureThreads, projects = fixtureProjects): ProjectThreads[] =>
  [{ id: WORKSPACE_ID, name: "Workspace" }, ...projects].map(({ id, name }) => ({ id, name, threads: threads.filter((thread) => thread.projectId === id), limit: THREAD_PAGE }));
const now = Date.UTC(2026, 9, 23, 12);

describe("homeItems", () => {
  it("lists waiting threads first across projects, then Workspace and each project with pins ahead", () => {
    expect(outline(homeItems(groups(), now))).toEqual([
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
    const loading: ProjectThreads = { id: "website", name: "website", threads: undefined, limit: THREAD_PAGE };
    expect(outline(homeItems([...groups(idle, [fixtureProjects[2]!]), loading], now))).toEqual(["# Workspace (2 threads)", "t-plan", "t-slack", "# immaculate (No threads)", "# website (…)"]);
  });

  it("starts a thread from a project's heading, but not from Needs you", () => {
    const headings = homeItems(groups(), now).filter((item) => item.kind === "heading");
    expect(headings.map((item) => item.projectId)).toEqual([null, WORKSPACE_ID, "openorc", "website", "immaculate"]);
  });

  it("shows a page of threads and Show more while the Mac lists more, then the next page", () => {
    const many: ThreadSummary[] = Array.from({ length: THREAD_PAGE + 3 }, (_, index) => ({ ...fixtureThreads[1]!, id: `w-${index}`, lastActivityAt: now - index }));
    const workspace = (limit: number): ProjectThreads[] => [{ id: WORKSPACE_ID, name: "Workspace", threads: many.slice(0, limit + 1), limit }];
    const first = outline(homeItems(workspace(THREAD_PAGE), now));
    expect(first).toHaveLength(1 + THREAD_PAGE + 1);
    expect(first.at(-1)).toBe(`more ${WORKSPACE_ID}`);
    expect(first[0]).toBe(`# Workspace (${THREAD_PAGE}+ threads)`);
    const second = outline(homeItems(workspace(THREAD_PAGE * 2), now));
    expect(second).toEqual([`# Workspace (${THREAD_PAGE + 3} threads)`, ...many.map((thread) => thread.id)]);
  });
});
