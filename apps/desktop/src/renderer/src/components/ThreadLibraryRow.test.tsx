import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { ThreadRow } from "./ThreadLibraryRow";
import { TipLayer } from "./TipLayer";
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
  subagent: { status: "running", agentType: "reviewer", toolCallId: null, startedAt: Date.now() - 72_000, endedAt: null, stoppable: true },
} as unknown as ThreadSummary;

it("moves a running subagent's elapsed time to its hover and spoken facts while retaining its type", () => {
  render(
    <TooltipProvider>
      <ThreadRow thread={subagent} active={false} compact />
    </TooltipProvider>,
  );
  const row = screen.getByText("Build teammate tags").closest("button")!;
  expect(row.textContent).toBe("Build teammate tags");
  expect(row.getAttribute("data-tip-detail")).toMatch(/ · Running for 1m \d+s$/);
  expect(row.getAttribute("aria-description")).toContain("Subagent · reviewer");
  expect(row.getAttribute("aria-description")).toContain(row.getAttribute("data-tip-detail"));
});

it("shows a cloud glyph, dims it offline, and preserves place and teammate names in hover and spoken facts", () => {
  const hosted = {
    ...subagent,
    id: "hosted",
    title: "Retry the cloud start",
    projectId: "studio",
    workspaceMode: "worktree",
    branch: "feature/retry",
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
  expect(screen.getByRole("img", { name: "OpenOrc Cloud" }).textContent).toBe("");
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
  expect(screen.getByText(hosted.title).closest("button")?.getAttribute("data-tip-detail")).toContain(" · Worktree · feature/retry");
  cleanup();
  render(
    <TooltipProvider>
      <ThreadRow thread={{ ...hosted, owner: { brain: "hosted", reach: "live", heardAt: 0, startedBy: { name: "Ana Lee", image: null } } }} active={false} />
    </TooltipProvider>,
  );
  const row = screen.getByText(hosted.title).closest("button")!;
  expect(row.textContent).not.toContain("Ana");
  expect(row.getAttribute("aria-description")).toContain("Ana Lee · OpenOrc Cloud");
  expect(row.getAttribute("data-tip-detail")).toContain("Ana Lee · OpenOrc Cloud");
});

it("keeps all four facts together, with the teammate's waiting mark separate from its PR", () => {
  render(
    <ThreadRow
      thread={{
        ...subagent,
        subagent: undefined,
        activity: "waiting",
        prUrl: "https://github.com/example/app/pull/8",
        prState: "merged",
        owner: { brain: "hosted", reach: "live", heardAt: 0, project: { name: "Example" }, startedBy: { name: "Morgan Reed", image: null } },
      }}
      active={false}
      compact
    />,
  );
  expect(screen.getByRole("img", { name: "OpenOrc Cloud" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Pull request #8, merged" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Waiting on Morgan" })).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Needs you" })).toBeNull();
  expect(screen.getByText(subagent.title).closest("button")?.getAttribute("aria-description")).toContain("Morgan Reed");
});

it.each(["completed", "failed", "no_updates"] as const)("retains the subagent's %s mark without a running timer", (status) => {
  render(<ThreadRow thread={{ ...subagent, activity: "idle", subagent: { ...subagent.subagent!, status } }} active={false} compact />);
  expect(screen.getAllByRole("img")).toHaveLength(1);
  expect(screen.getByText(subagent.title).closest("button")?.getAttribute("data-tip-detail")).not.toContain("Running for");
});

it("shows the full clipped title above the facts on hover and on keyboard focus", () => {
  vi.useFakeTimers();
  render(
    <>
      <ThreadRow thread={{ ...subagent, subagent: undefined }} active={false} project={{ name: "Example" }} />
      <TipLayer />
    </>,
  );
  const title = screen.getByText(subagent.title);
  Object.defineProperties(title, { scrollWidth: { value: 300 }, clientWidth: { value: 100 } });
  title.style.overflow = "hidden";
  const row = title.closest("button")!;
  fireEvent.mouseOver(title);
  act(() => {
    vi.advanceTimersByTime(850);
  });
  expect(document.querySelector(".tooltip-popup-detail")?.textContent).toBe(`${subagent.title}\n${row.getAttribute("data-tip-detail")}`);
  fireEvent.mouseOver(document.body);
  act(() => {
    vi.advanceTimersByTime(500);
    row.focus();
    vi.advanceTimersByTime(1);
  });
  expect(document.querySelector(".tooltip-popup-detail")?.textContent).toBe(`${subagent.title}\n${row.getAttribute("data-tip-detail")}`);
});
