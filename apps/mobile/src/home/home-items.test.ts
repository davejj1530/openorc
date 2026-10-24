import { WORKSPACE_ID } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { fixtureProjects, fixtureThreads } from "./fixtures";
import { homeItems, type HomeItem } from "./home-items";

const outline = (items: HomeItem[]) =>
  items.map((item) => {
    if (item.kind === "heading") return `# ${item.title} (${item.meta})`;
    if (item.kind === "pinned") return `pinned ${item.count}`;
    return item.project ? `${item.thread.id} @ ${item.project}` : item.thread.id;
  });

describe("homeItems", () => {
  it("lists waiting threads first across projects, then Workspace and each project with pins ahead", () => {
    expect(outline(homeItems(fixtureProjects, fixtureThreads))).toEqual([
      "# Needs you (2)",
      "t-pairing @ openorc",
      "t-docs @ website",
      "# Workspace (2 threads)",
      "t-slack",
      "t-plan",
      "# openorc (1 running)",
      "pinned 2",
      "t-notes",
      "t-headline",
      "t-paging",
      "t-ledger",
      "t-settings",
      "# website (1 running)",
      "t-hero",
      "t-phone",
      "# immaculate (2 threads)",
      "t-tokens",
      "t-canvas",
    ]);
  });

  it("keeps a project heading when it lists nothing, and omits Needs you when nothing waits", () => {
    const idle = fixtureThreads.filter((thread) => thread.activity !== "waiting" && thread.projectId === WORKSPACE_ID);
    expect(outline(homeItems([fixtureProjects[2]!], idle))).toEqual(["# Workspace (2 threads)", "t-slack", "t-plan", "# immaculate (No threads)"]);
  });
});
