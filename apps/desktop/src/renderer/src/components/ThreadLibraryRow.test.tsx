import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { ThreadRow } from "./ThreadLibraryRow";
import { TooltipProvider } from "./ui";

vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));
vi.mock("../lib/client", () => ({ useRpc: () => ({ data: { defaultWorkspaceMode: "current" } }) }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const subagent = {
  id: "helper",
  title: "Build teammate tags",
  projectId: WORKSPACE_ID,
  agent: "claude",
  branch: "main",
  activity: "running",
  unread: false,
  session: { status: "live", message: null },
  pinnedAt: null,
  snoozedUntil: null,
  archivedAt: null,
  createdAt: 0,
  lastActivityAt: Date.now(),
  parentThreadId: "parent",
  parentRelation: "subagent",
  subagent: { status: "running", agentType: "pstack:poteto-agent-high", toolCallId: null, startedAt: Date.now() - 72_000, endedAt: null, stoppable: true },
} as unknown as ThreadSummary;

it("keeps a subagent's row to its title and running time, and gives its type to the row's description", () => {
  render(
    <TooltipProvider>
      <ThreadRow thread={subagent} active={false} compact />
    </TooltipProvider>,
  );
  const row = screen.getByText("Build teammate tags").closest("button")!;
  expect(row.textContent).not.toContain("poteto");
  expect(row.textContent).toMatch(/1m \d+s/);
  expect(row.getAttribute("aria-description")).toBe("Subagent · pstack:poteto-agent-high · Claude");
});

it("marks a thread on OpenOrc Cloud with the cloud and its name, dimmed while OpenOrc Cloud can't be reached, and names a teammate who started it", () => {
  const hosted = {
    ...subagent,
    id: "hosted",
    title: "Retry the cloud start",
    projectId: "studio",
    workspaceMode: "worktree",
    branch: "openorc/retry",
    activity: "idle",
    session: { status: "idle", message: null },
    parentThreadId: null,
    parentRelation: null,
    subagent: undefined,
    prUrl: null,
    owner: { brain: "hosted", reach: "live", heardAt: Date.now() },
  } as unknown as ThreadSummary;
  const { rerender } = render(
    <TooltipProvider>
      <ThreadRow thread={hosted} active={false} />
    </TooltipProvider>,
  );
  expect(screen.getByRole("img", { name: "OpenOrc Cloud" }).textContent).toBe("OpenOrc Cloud");
  expect(screen.getByRole("img", { name: "OpenOrc Cloud" }).className).not.toContain("opacity-60");
  rerender(
    <TooltipProvider>
      <ThreadRow thread={{ ...hosted, owner: { brain: "hosted", reach: "offline", heardAt: 0 } }} active={false} />
    </TooltipProvider>,
  );
  expect(screen.getByRole("img", { name: "OpenOrc Cloud" }).className).toContain("opacity-60");
  cleanup();
  render(
    <TooltipProvider>
      <ThreadRow thread={{ ...hosted, owner: undefined }} active={false} />
    </TooltipProvider>,
  );
  expect(screen.queryByRole("img", { name: "OpenOrc Cloud" })).toBeNull();
  expect(screen.getByText("worktree")).toBeTruthy();
  cleanup();
  render(
    <TooltipProvider>
      <ThreadRow thread={{ ...hosted, owner: { brain: "hosted", reach: "live", heardAt: 0, startedBy: { name: "Ana Lee", image: null } } }} active={false} />
    </TooltipProvider>,
  );
  expect(screen.getByText("Ana").closest("[data-tip]")?.getAttribute("data-tip")).toBe("Ana Lee");
});
