import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { defaultOrclingLook, type Orcling, type OrclingGroup, type ThreadSummary } from "@openorc/protocol";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

const threads = new Map<string, ThreadSummary>();
const lists = { orclings: [] as Orcling[], groups: [] as OrclingGroup[] };

vi.mock("./ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui")>()),
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string, params: { id: string }) => {
    if (method === "orclings.list") return { data: lists.orclings };
    if (method === "orclings.groups.list") return { data: lists.groups };
    return { data: threads.get(params.id), isSuccess: threads.has(params.id) };
  },
}));

import { useThreadTabs } from "../lib/thread-tabs";
import { ThreadTabs } from "./ThreadTabs";

afterEach(() => {
  cleanup();
  threads.clear();
  lists.orclings = [];
  lists.groups = [];
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

it("marks an Orcling's chat with its face and a group chat with its members' faces, not the agent they run on", () => {
  const orcling = (id: string) => ({ id, name: id, threadId: `${id}-chat`, look: defaultOrclingLook }) as Orcling;
  lists.orclings = [orcling("pip"), orcling("bo")];
  lists.groups = [{ threadId: "group", title: "Pip and Bo", memberIds: ["pip", "bo"], createdAt: 0 }];
  threads.set("pip-chat", thread("pip-chat", "codex", { orclingId: "pip" }));
  threads.set("group", thread("group", "codex"));
  useThreadTabs.setState({
    tabs: [
      { id: "a", route: { view: "thread", threadId: "pip-chat" } },
      { id: "b", route: { view: "thread", threadId: "group" } },
    ],
    active: "a",
    leaving: [],
  });
  const { container } = render(<ThreadTabs />);
  expect(markOf(container, "a")?.matches("svg.orcling-avatar")).toBe(true);
  expect(markOf(container, "b")?.getAttribute("aria-label")).toBe("pip, bo");
  expect(markOf(container, "b")?.querySelectorAll("svg.orcling-avatar")).toHaveLength(2);
  expect(container.querySelector("[data-provider]")).toBeNull();
});

const order = (container: HTMLElement) => [...container.querySelectorAll("[data-tab]")].map((tab) => tab.getAttribute("data-tab"));

it("leads with the open thread as the column's heading, the other open threads after it in their own order", () => {
  for (const id of ["t1", "t2", "t3"]) threads.set(id, thread(id, "codex"));
  useThreadTabs.setState({
    tabs: [
      { id: "a", route: { view: "thread", threadId: "t1" } },
      { id: "b", route: { view: "thread", threadId: "t2" } },
      { id: "c", route: { view: "thread", threadId: "t3" } },
    ],
    active: "b",
    leaving: [],
  });
  const { container } = render(<ThreadTabs />);
  expect(order(container)).toEqual(["b", "a", "c"]);
  expect(container.querySelector(".thread-tab-heading")?.getAttribute("data-tab")).toBe("b");
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe("t2");
  expect(container.querySelector(".work-tabs [data-tab='b']")).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: "t3" }));
  expect(useThreadTabs.getState().active).toBe("c");
  expect(order(container)).toEqual(["c", "a", "b"]);

  fireEvent.click(within(container.querySelector(".thread-tab-heading") as HTMLElement).getByRole("button", { name: "Close tab" }));
  expect(useThreadTabs.getState().active).toBe("b");
  expect(container.querySelector(".thread-tab-heading")?.getAttribute("data-tab")).toBe("b");
});

it("moves from the heading through the other threads with the arrow keys", () => {
  for (const id of ["t1", "t2"]) threads.set(id, thread(id, "codex"));
  useThreadTabs.setState({
    tabs: [
      { id: "a", route: { view: "thread", threadId: "t1" } },
      { id: "b", route: { view: "thread", threadId: "t2" } },
    ],
    active: "b",
    leaving: [],
  });
  render(<ThreadTabs />);
  fireEvent.keyDown(screen.getByRole("tab", { selected: true }), { key: "ArrowRight" });
  expect(useThreadTabs.getState().active).toBe("a");
});
