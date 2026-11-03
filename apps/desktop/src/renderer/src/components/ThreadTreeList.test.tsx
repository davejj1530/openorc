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
