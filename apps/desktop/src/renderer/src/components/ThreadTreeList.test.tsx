import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadSummary } from "@openorc/protocol";
import { useLayout } from "../lib/layout";
import { ThreadTreeList } from "./ThreadTreeList";

vi.mock("./ThreadLibraryRow", () => ({ ThreadRow: ({ thread }: { thread: ThreadSummary }) => <span>{thread.title}</span> }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("pages children and fetches more for that parent, preserving an older running child and search hits", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const parent = { id: "parent", projectId: "project", title: "Parent", activity: "idle", createdAt: 0 } as ThreadSummary;
  const children = Array.from({ length: 20 }, (_, i): ThreadSummary => ({
    ...parent,
    id: `child-${i}`,
    title: `Child ${i}`,
    parentThreadId: parent.id,
    parentRelation: "subagent",
    createdAt: i,
    activity: i === 0 ? "running" : "idle",
  }));
  const more = vi.fn();
  useLayout.setState({ collapsed: [] });
  const props = { roots: [parent], all: [parent, ...children], activeId: null, onShowMore: more };
  const view = render(<ThreadTreeList {...props} />);
  const button = screen.getByRole("button", { name: "Show 14 more in Parent" });
  expect(screen.getByText("Child 0")).toBeTruthy();
  expect(screen.queryByText("Child 14")).toBeNull();
  fireEvent.click(button);
  expect(more).toHaveBeenCalledExactlyOnceWith("project", "parent");
  view.rerender(<ThreadTreeList {...props} childLimits={{ parent: 17 }} />);
  expect(screen.getByText("Child 14")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show 2 more in Parent" })).toBeTruthy();
  view.rerender(<ThreadTreeList {...props} search="Child 1" />);
  expect(screen.getByText("Child 1")).toBeTruthy();
  expect(screen.getByText("Child 10")).toBeTruthy();
  view.rerender(<ThreadTreeList {...props} activeId="child-2" />);
  expect(screen.getByText("Child 2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Collapse Parent" }));
  expect(screen.queryByText(/Show \d+ more/)).toBeNull();
  expect(screen.queryByText("Child 0")).toBeNull();
});

it("reveals a selected grandchild once, lets the user collapse it, and reveals again on navigation", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const parent = { id: "parent", title: "Parent", activity: "idle", createdAt: 1 } as ThreadSummary;
  const child = { ...parent, id: "child", title: "Child", parentThreadId: "parent", parentRelation: "subagent" } as ThreadSummary;
  const nested = { ...child, id: "nested", title: "Nested", parentThreadId: "child" };
  useLayout.setState({ collapsed: ["thread-closed:parent", "thread-closed:child"] });
  const props = { roots: [parent], all: [parent, child, nested] };
  const view = render(<ThreadTreeList {...props} activeId="nested" />);
  expect(screen.getByText("Nested")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Collapse Parent" }));
  expect(screen.queryByText("Nested")).toBeNull();
  view.rerender(<ThreadTreeList {...props} activeId="nested" />);
  expect(screen.queryByText("Nested")).toBeNull();
  view.rerender(<ThreadTreeList {...props} activeId="parent" />);
  view.rerender(<ThreadTreeList {...props} activeId="nested" />);
  expect(screen.getByText("Nested")).toBeTruthy();
  act(() => useLayout.getState().pruneThreadFolds(new Set(["parent", "child"])));
  expect(useLayout.getState().collapsed).toEqual([]);
});

it("reveals search matches temporarily without erasing manually closed branches", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const parent = { id: "parent", title: "Parent", activity: "idle", createdAt: 1 } as ThreadSummary;
  const child = { ...parent, id: "child", title: "Find me", parentThreadId: "parent", parentRelation: "subagent" } as ThreadSummary;
  useLayout.setState({ collapsed: ["thread-closed:parent"] });
  const props = { roots: [parent], all: [parent, child], activeId: null };
  const view = render(<ThreadTreeList {...props} />);
  expect(screen.queryByText("Find me")).toBeNull();
  view.rerender(<ThreadTreeList {...props} search="Find me" />);
  expect(screen.getByText("Find me")).toBeTruthy();
  expect(useLayout.getState().collapsed).toEqual(["thread-closed:parent"]);
  view.rerender(<ThreadTreeList {...props} />);
  expect(screen.queryByText("Find me")).toBeNull();
});
