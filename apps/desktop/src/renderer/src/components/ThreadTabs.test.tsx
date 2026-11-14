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

it("keeps every open thread where it was opened when one is chosen, by click or by key, marking only that one", () => {
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
  expect(order(container)).toEqual(["a", "b", "c"]);
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe("t2");

  fireEvent.click(screen.getByRole("tab", { name: "t3" }));
  expect(useThreadTabs.getState().active).toBe("c");
  expect(order(container)).toEqual(["a", "b", "c"]);
  expect(container.querySelectorAll(".work-tab-current")).toHaveLength(1);
  expect(container.querySelector(".work-tab-current")?.getAttribute("data-tab")).toBe("c");

  fireEvent.keyDown(screen.getByRole("tab", { selected: true }), { key: "Home" });
  expect(useThreadTabs.getState().active).toBe("a");
  expect(document.activeElement?.textContent).toBe("t1");
  fireEvent.keyDown(screen.getByRole("tab", { selected: true }), { key: "ArrowRight" });
  expect(useThreadTabs.getState().active).toBe("b");
  fireEvent.keyDown(screen.getByRole("tab", { selected: true }), { key: "End" });
  expect(useThreadTabs.getState().active).toBe("c");
  expect(order(container)).toEqual(["a", "b", "c"]);
});

it("closes a tab from its own close, leaving the others in their order", () => {
  for (const id of ["t1", "t2", "t3"]) threads.set(id, thread(id, "codex"));
  useThreadTabs.setState({
    tabs: [
      { id: "a", route: { view: "thread", threadId: "t1" } },
      { id: "b", route: { view: "thread", threadId: "t2" } },
      { id: "c", route: { view: "thread", threadId: "t3" } },
    ],
    active: "a",
    leaving: [],
  });
  const { container } = render(<ThreadTabs />);
  fireEvent.click(within(container.querySelector('[data-tab="b"]') as HTMLElement).getByRole("button", { name: "Close tab" }));
  expect(useThreadTabs.getState().active).toBe("a");
  expect(
    useThreadTabs
      .getState()
      .tabs.filter((tab) => !useThreadTabs.getState().leaving.includes(tab.id))
      .map((tab) => tab.id),
  ).toEqual(["a", "c"]);
});
