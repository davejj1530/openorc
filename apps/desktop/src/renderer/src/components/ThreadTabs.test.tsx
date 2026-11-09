import { cleanup, render } from "@testing-library/react";
import type { ThreadSummary } from "@openorc/protocol";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

const threads = new Map<string, ThreadSummary>();

vi.mock("./ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui")>()),
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (_method: string, params: { id: string }) => ({ data: threads.get(params.id), isSuccess: threads.has(params.id) }),
}));

import { useThreadTabs } from "../lib/thread-tabs";
import { ThreadTabs } from "./ThreadTabs";

afterEach(() => {
  cleanup();
  threads.clear();
});

const thread = (id: string, agent: string, extra: object = {}) =>
  ({ id, title: id, projectId: "p1", agent, activity: "idle", unread: false, session: { status: "idle" }, ...extra }) as unknown as ThreadSummary;

const markOf = (container: HTMLElement, tab: string) => container.querySelector(`[data-tab="${tab}"] .work-tab-icon`);

it("marks each thread's tab with the agent it runs on, and follows the thread to another agent", () => {
  threads.set("t1", thread("t1", "claude"));
  threads.set("t2", thread("t2", "codex"));
  useThreadTabs.setState({
    tabs: [
      { id: "a", route: { view: "thread", threadId: "t1" } },
      { id: "b", route: { view: "thread", threadId: "t2" } },
      { id: "c", route: { view: "newthread", projectId: "p1" } },
    ],
    active: "a",
    leaving: [],
  });
  const { container, rerender } = render(<ThreadTabs />);
  expect(markOf(container, "a")?.getAttribute("data-provider")).toBe("claude");
  expect(markOf(container, "b")?.getAttribute("data-provider")).toBe("codex");
  expect(markOf(container, "c")?.getAttribute("data-provider")).toBeNull();

  threads.set("t1", thread("t1", "opencode"));
  rerender(<ThreadTabs />);
  expect(markOf(container, "a")?.getAttribute("data-provider")).toBe("opencode");
});

it("shows a thread's state over its agent's mark while it has one, and no stand-in before the thread is read", () => {
  threads.set("t1", thread("t1", "claude", { activity: "running" }));
  useThreadTabs.setState({
    tabs: [
      { id: "a", route: { view: "thread", threadId: "t1" } },
      { id: "b", route: { view: "thread", threadId: "unread-yet" } },
    ],
    active: "a",
    leaving: [],
  });
  const { container } = render(<ThreadTabs />);
  expect(markOf(container, "a")?.getAttribute("data-provider")).toBeNull();
  expect(container.querySelector('[data-tab="a"] img')).toBeNull();
  expect(markOf(container, "b")?.childElementCount).toBe(0);
  expect(container.querySelector('[data-tab="b"] img, [data-tab="b"] svg.work-tab-icon')).toBeNull();
});
