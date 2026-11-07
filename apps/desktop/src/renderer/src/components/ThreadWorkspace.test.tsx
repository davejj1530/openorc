import type { ConversationPlan } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mutate, planThreads, documents, teamThreads, subagentThreads } = vi.hoisted(() => ({
  mutate: vi.fn(),
  planThreads: new Set<string>(),
  documents: new Map<string, ConversationPlan[]>(),
  teamThreads: new Set<string>(),
  subagentThreads: new Set<string>(),
}));
vi.mock("../lib/client", async (original) => {
  const rpcData = (method: string, params: { id?: string }) => {
    if (method === "projects.list") return [];
    if (method === "threads.get")
      return {
        id: params.id,
        title: `Thread ${params.id}`,
        projectId: "project",
        teamInstanceId: teamThreads.has(params.id ?? "") ? "team" : null,
        activity: "idle",
        agent: "claude",
        parentRelation: subagentThreads.has(params.id ?? "") ? "subagent" : null,
        parentThreadId: subagentThreads.has(params.id ?? "") ? "parent" : null,
        mode: planThreads.has(params.id ?? "") ? "plan" : "act",
        prUrl: `https://example.com/${params.id}`,
      };
    if (method === "threads.plans") return documents.get(params.id ?? "") ?? [];
    return { id: "project", name: "Project" };
  };
  return { ...(await original<object>()), useRpc: (method: string, params: { id?: string }) => ({ isSuccess: true, data: rpcData(method, params) }), useRpcMutation: () => ({ mutate }) };
});
vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onPush: () => () => {} } }));
vi.mock("../lib/window", () => ({ useTrafficLights: () => true, useWindowsControls: () => false }));
vi.mock("./Sidebar", () => ({ WindowNav: () => null }));
vi.mock("./Panel", () => ({ Panel: () => <div data-testid="shared-panel" /> }));
vi.mock("./ThreadClaudeAccount", () => ({ ThreadClaudeAccount: () => <button>Claude account</button> }));
vi.mock("./SubagentConversation", () => ({ SubagentConversation: () => null, ThreadParent: () => null }));
// Keep real headers and controls; tooltip positioning is exercised in the Electron smoke.
vi.mock("./ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui")>()),
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ThreadActions", () => ({ ThreadMenuItems: () => null }));
vi.mock("./Conversation", () => ({
  Conversation: ({ scope }: { scope: { thread: { id: string } } }) => (
    <div data-testid={`conversation-${scope.thread.id}`}>
      <textarea aria-label={`Composer ${scope.thread.id}`} />
      <button onPointerDown={(event) => event.stopPropagation()}>Conversation control</button>
    </div>
  ),
}));

import { useLayout } from "../lib/layout";
import { useRouter } from "../lib/router";
import { ThreadWorkspace } from "./ThreadWorkspace";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.clearAllMocks();
  planThreads.clear();
  documents.clear();
  teamThreads.clear();
  subagentThreads.clear();
  window.openorc = { ...window.openorc, openExternal: vi.fn() };
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  useRouter.setState({ route: { view: "thread", threadId: "a" }, threadIds: ["a"], history: [], future: [] });
  useLayout.setState({ sidebarOpen: true, panelOpen: false, panelSide: "right", panelThreadId: "a", panelTab: "changes", projectId: null });
});

const active = () => useRouter.getState().route;
const expectActive = (id: string) => expect(active()).toEqual({ view: "thread", threadId: id });
const focusA = () => act(() => useRouter.getState().focusThreadPane("a"));

it("omits the account switcher and refuses a saved panel owner that is a subagent", () => {
  subagentThreads.add("a");
  useLayout.setState({ panelOpen: true, panelThreadId: "a", panelSide: "left", sidebarOpen: false });
  const { container } = render(<ThreadWorkspace />);
  expect(screen.queryByRole("button", { name: "Claude account" })).toBeNull();
  expect(screen.queryByTestId("shared-panel")).toBeNull();
  expect(container.querySelector('[data-thread-pane="a"] header')!.hasAttribute("data-window-navigation")).toBe(true);
});

const document = (id: string, source: ConversationPlan["source"] = "native"): ConversationPlan => ({
  id,
  threadId: "b",
  runId: "run",
  revision: 1,
  text: "# Proposed plan",
  state: "draft",
  source,
  updatedAt: 1,
});

it("waits for an emitted plan and preserves manual sidebar choices", () => {
  planThreads.add("b");
  useRouter.setState({ threadIds: ["a", "b"] });
  const view = render(<ThreadWorkspace />);
  act(() => useRouter.getState().focusThreadPane("b"));
  expect(useLayout.getState().panelOpen).toBe(false);

  documents.set("b", [document("discussion", "response")]);
  view.rerender(<ThreadWorkspace />);
  expect(useLayout.getState().panelOpen).toBe(false);
  documents.set("b", [document("proposal")]);
  view.rerender(<ThreadWorkspace />);
  expect(useLayout.getState()).toMatchObject({ panelThreadId: "b", panelOpen: true, panelTab: "plan" });

  act(() => useLayout.setState({ panelOpen: false, panelTab: "tasks" }));
  documents.set("b", [{ ...document("proposal"), text: "# Complete plan", state: "ready" }]);
  view.rerender(<ThreadWorkspace />);
  focusA();
  act(() => useRouter.getState().focusThreadPane("b"));
  expect(useLayout.getState()).toMatchObject({ panelOpen: false, panelTab: "tasks" });

  documents.set("b", [document("revision-2"), document("proposal")]);
  view.rerender(<ThreadWorkspace />);
  expect(useLayout.getState()).toMatchObject({ panelThreadId: "b", panelOpen: true, panelTab: "plan" });
});

it("swaps the open panel's side from the thread header, handing the window navigation to whichever column comes first", () => {
  useLayout.setState({ sidebarOpen: false });
  const { container } = render(<ThreadWorkspace />);
  const header = () => container.querySelector<HTMLElement>('[data-thread-pane="a"] header')!;
  expect(within(header()).queryByRole("button", { name: "Move panel left" })).toBeNull();

  act(() => useLayout.getState().toggleThreadPanel("a"));
  fireEvent.click(within(header()).getByRole("button", { name: "Move panel left" }));
  expect(useLayout.getState().panelSide).toBe("left");
  expect(header().hasAttribute("data-window-navigation")).toBe(false);

  fireEvent.click(within(header()).getByRole("button", { name: "Move panel right" }));
  expect(useLayout.getState().panelSide).toBe("right");
  expect(header().hasAttribute("data-window-navigation")).toBe(true);
});

it("keeps the window navigation in the thread header while the left panel belongs to a thread off screen", () => {
  useLayout.setState({ sidebarOpen: false, panelOpen: true, panelSide: "left", panelThreadId: "elsewhere" });
  const { container } = render(<ThreadWorkspace />);
  expect(container.querySelector('[data-thread-pane="a"] header')!.hasAttribute("data-window-navigation")).toBe(true);
});

describe.each([{ ids: ["a", "b"] }, { ids: ["a", "b", "c"] }])("header focus boundaries in $ids", ({ ids }) => {
  const setup = () => {
    useRouter.setState({ threadIds: ids });
    return render(<ThreadWorkspace />);
  };

  it("keeps header background, title and control focus from activating an unfocused pane", () => {
    const { container } = setup();
    for (const id of ids.slice(1)) {
      const header = container.querySelector(`[data-thread-pane="${id}"] header`)!;
      const title = within(header as HTMLElement).getByText(`Thread ${id}`);
      expect(title.tagName).toBe("BUTTON");
      for (const target of [header, title, within(header as HTMLElement).getByRole("button", { name: "Open the pull request" })]) {
        fireEvent.pointerDown(target);
        fireEvent.mouseDown(target);
        fireEvent.pointerMove(target);
        fireEvent.pointerUp(target);
        fireEvent.click(target);
        fireEvent.focus(target);
        expectActive("a");
      }
      const titleInput = within(header as HTMLElement).getByRole("textbox", { name: "Thread title" });
      fireEvent.focus(titleInput);
      expectActive("a");
      fireEvent.keyDown(titleInput, { key: "Escape" });
      expect(window.openorc.openExternal).toHaveBeenCalledWith(`https://example.com/${id}`);
    }
  });

  it("activates through conversation pointer capture and keyboard focus without remounting composers", () => {
    setup();
    const alpha = screen.getByRole("textbox", { name: "Composer a" });
    fireEvent.change(alpha, { target: { value: "Alpha draft" } });
    for (const id of ids.slice(1)) {
      const body = screen.getByTestId(`conversation-${id}`);
      fireEvent.pointerDown(body);
      expectActive(id);
      focusA();
      fireEvent.pointerDown(within(body).getByRole("button"));
      expectActive(id);
      focusA();
      fireEvent.focus(within(body).getByRole("textbox"));
      expectActive(id);
      focusA();
      fireEvent.focus(within(body).getByRole("button"));
      expectActive(id);
    }
    expect(screen.getByRole("textbox", { name: "Composer a" })).toBe(alpha);
    expect((alpha as HTMLTextAreaElement).value).toBe("Alpha draft");
  });

  it("toggles the owning panel and closes unfocused panes without selecting them", () => {
    const { container } = setup();
    for (const id of ids.slice(1)) {
      const pane = container.querySelector<HTMLElement>(`[data-thread-pane="${id}"]`)!;
      const toggle = within(pane).getByRole("button", { name: "Show panel" });
      fireEvent.pointerDown(toggle);
      fireEvent.focus(toggle);
      fireEvent.click(toggle);
      expect(useLayout.getState().panelThreadId).toBe(id);
      expect(useLayout.getState().panelOpen).toBe(true);
      expectActive("a");
      const close = within(pane).getByRole("button", { name: "Close pane" });
      fireEvent.pointerDown(close);
      fireEvent.focus(close);
      fireEvent.click(close);
      expect(useRouter.getState().threadIds).not.toContain(id);
      expectActive("a");
    }
  });
});

it("never opens a subagent workspace panel when a new native plan arrives", () => {
  subagentThreads.add("a");
  const view = render(<ThreadWorkspace />);
  documents.set("a", [{ ...document("child-plan"), threadId: "a" }]);
  view.rerender(<ThreadWorkspace />);
  expect(useLayout.getState().panelOpen).toBe(false);
});
