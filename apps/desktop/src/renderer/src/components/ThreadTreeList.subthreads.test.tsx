import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { useLayout } from "../lib/layout";
import { ThreadTreeList } from "./ThreadTreeList";

vi.mock("../lib/orclings", async (original) => ({ ...(await original<typeof import("../lib/orclings")>()), useOrclings: () => [] }));
vi.mock("./ThreadHeadline", async (original) => ({ ...(await original<typeof import("./ThreadHeadline")>()), useRowHeadline: () => null }));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const parent = {
  id: "parent",
  title: "Openorc UI tweaks",
  projectId: WORKSPACE_ID,
  agent: "claude",
  branch: "main",
  activity: "idle",
  unread: false,
  session: { status: "idle", message: null },
  pinnedAt: null,
  snoozedUntil: null,
  archivedAt: null,
  createdAt: 0,
  lastActivityAt: Date.now(),
  parentThreadId: null,
} as unknown as ThreadSummary;
const child = (id: string, activity: ThreadSummary["activity"], parentThreadId = parent.id) =>
  ({ ...parent, id, title: `Sub ${id}`, activity, parentThreadId, parentRelation: "started" }) as ThreadSummary;
const parentRow = () => screen.getByText("Openorc UI tweaks").closest("button")!;

it("marks a folded parent whose sub threads work or need you, without sweeping its own title", () => {
  useLayout.setState({ collapsed: ["thread-closed:parent"] });
  const all = [parent, child("a", "running"), child("b", "idle"), child("c", "running", "b")];
  const view = render(<ThreadTreeList roots={[parent]} all={all} activeId={null} />);
  expect(screen.queryByText("Sub a")).toBeNull();
  expect(within(parentRow()).getByRole("img", { name: "2 subthreads are working" })).toBeTruthy();
  expect(parentRow().querySelector("[data-working]")).toBeNull();

  view.rerender(<ThreadTreeList roots={[parent]} all={[parent, child("a", "running"), child("b", "waiting")]} activeId={null} />);
  expect(within(parentRow()).getByRole("img", { name: "A subthread needs you" })).toBeTruthy();

  view.rerender(<ThreadTreeList roots={[parent]} all={[parent, child("a", "idle")]} activeId={null} />);
  expect(within(parentRow()).queryByRole("img", { name: /subthread|Working/ })).toBeNull();
});

it("keeps the mark on an open parent and on a sub thread whose own sub thread works", () => {
  useLayout.setState({ collapsed: [] });
  render(<ThreadTreeList roots={[parent]} all={[parent, child("b", "idle"), child("c", "running", "b")]} activeId={null} />);
  expect(within(parentRow()).getByRole("img", { name: "A subthread is working" })).toBeTruthy();
  const middle = screen.getByText("Sub b").closest("button")!;
  expect(within(middle).getByRole("img", { name: "A subthread is working" })).toBeTruthy();
  expect(within(screen.getByText("Sub c").closest("button")!).getByRole("img", { name: "Working" })).toBeTruthy();
});
