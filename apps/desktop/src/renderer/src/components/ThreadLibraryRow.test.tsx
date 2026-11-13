import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { ThreadRow } from "./ThreadLibraryRow";
import { TooltipProvider } from "./ui";

vi.mock("../lib/orclings", async (original) => ({ ...(await original<typeof import("../lib/orclings")>()), useOrclings: () => [] }));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));
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

it("keeps a subagent's row to its title and running time, and names its type once the row is hovered", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  render(
    <TooltipProvider>
      <ThreadRow thread={subagent} active={false} compact />
    </TooltipProvider>,
  );
  const row = screen.getByText("Build teammate tags").closest("button")!;
  expect(row.textContent).not.toContain("poteto");
  expect(row.textContent).toMatch(/1m \d+s/);
  expect(row.title).toBe("");
  fireEvent.mouseEnter(row);
  fireEvent.mouseMove(row);
  await act(async () => vi.advanceTimersByTime(300));
  expect(screen.queryByText(/Subagent · /)).toBeNull();
  await act(async () => vi.advanceTimersByTime(150));
  expect(screen.getByText(/^Subagent · pstack:poteto-agent-high · Claude · /)).toBeTruthy();
});

it("marks a thread on OpenOrc Cloud with the cloud, dimmed while OpenOrc Cloud can't be reached", () => {
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
  expect(screen.getByText("worktree")).toBeTruthy();
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
  cleanup();
  render(
    <TooltipProvider>
      <ThreadRow thread={{ ...hosted, owner: { brain: "hosted", reach: "live", heardAt: 0, startedBy: { name: "Ana Lee", image: null } } }} active={false} />
    </TooltipProvider>,
  );
  expect(screen.getByText("Ana Lee")).toBeTruthy();
  expect(screen.queryByText("worktree")).toBeNull();
});
