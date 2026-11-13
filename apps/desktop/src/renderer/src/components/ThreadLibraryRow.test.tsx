import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { ThreadRow } from "./ThreadLibraryRow";
import { TooltipProvider } from "./ui";

vi.mock("../lib/orclings", async (original) => ({ ...(await original<typeof import("../lib/orclings")>()), useOrclings: () => [] }));
vi.mock("./ThreadHeadline", async (original) => ({ ...(await original<typeof import("./ThreadHeadline")>()), useRowHeadline: () => null }));
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
