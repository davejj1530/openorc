import { WORKSPACE_ID } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { homeItems, type HomeItem, type ProjectThreads } from "./home-items";
import { fixtureProjects, fixtureThreads } from "./test-fixtures/threads";

const outline = (items: HomeItem[]) =>
  items.map((item) => {
    if (item.kind === "heading") return `# ${item.title} (${item.meta?.text ?? "…"})`;
    if (item.kind === "pinned") return `pinned ${item.count}`;
    return item.project ? `${item.thread.id} @ ${item.project}` : item.thread.id;
  });

const groups = (threads = fixtureThreads, projects = fixtureProjects): ProjectThreads[] =>
  [{ id: WORKSPACE_ID, name: "Workspace" }, ...projects].map(({ id, name }) => ({ id, name, threads: threads.filter((thread) => thread.projectId === id) }));
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
    const loading: ProjectThreads = { id: "website", name: "website", threads: undefined };
    expect(outline(homeItems([...groups(idle, [fixtureProjects[2]!]), loading], now))).toEqual(["# Workspace (2 threads)", "t-plan", "t-slack", "# immaculate (No threads)", "# website (…)"]);
  });
});
