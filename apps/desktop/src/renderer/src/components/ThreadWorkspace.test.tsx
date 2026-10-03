import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ConversationPlan } from "@openorc/protocol";

const { mutate, planThreads, documents, teamThreads } = vi.hoisted(() => ({
  mutate: vi.fn(),
  planThreads: new Set<string>(),
  documents: new Map<string, ConversationPlan[]>(),
  teamThreads: new Set<string>(),
}));
vi.mock("../lib/query", () => {
  const rpcData = (method: string, params: { id?: string }) => {
    if (method === "projects.list") return [];
    if (method === "threads.get")
      return {
        id: params.id,
        title: `Thread ${params.id}`,
        projectId: "project",
        teamInstanceId: teamThreads.has(params.id ?? "") ? "team" : null,
        activity: "idle",
        mode: planThreads.has(params.id ?? "") ? "plan" : "act",
        prUrl: `https://example.com/${params.id}`,
      };
    if (method === "threads.plans") return documents.get(params.id ?? "") ?? [];
    if (method === "orchestration.runtime") return { executions: [{ actors: [{ id: "lead", runIds: ["run"] }] }] };
    return { id: "project", name: "Project" };
  };
  return {
    useRpc: (method: string, params: { id?: string }) => ({ isSuccess: true, data: rpcData(method, params) }),
    useRpcMutation: () => ({ mutate }),
  };
});
vi.mock("../lib/rpc", () => ({ core: { call: vi.fn() } }));
vi.mock("../lib/window", () => ({ useTrafficLights: () => true, useWindowsControls: () => false }));
vi.mock("./Sidebar", () => ({ WindowNav: () => null }));
vi.mock("./Panel", () => ({ Panel: () => null }));
// Keep real headers and controls; tooltip positioning is exercised in the Electron smoke.
vi.mock("./ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui")>()),
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ThreadActions", () => ({ menuItem: "", menuPopup: "", ThreadMenuItems: () => null }));
vi.mock("./Conversation", () => ({
  Conversation: ({ scope }: { scope: { thread: { id: string } } }) => (
    <div data-testid={`conversation-${scope.thread.id}`}>
      <textarea aria-label={`Composer ${scope.thread.id}`} />
      <button onPointerDown={(event) => event.stopPropagation()}>Conversation control</button>
    </div>
  ),
}));

import { ThreadWorkspace } from "./ThreadWorkspace";
import { useRouter } from "../lib/router";
import { useLayout } from "../lib/layout";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.clearAllMocks();
  planThreads.clear();
  documents.clear();
  teamThreads.clear();
  window.openorc = { ...window.openorc, openExternal: vi.fn() };
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  useRouter.setState({ route: { view: "thread", threadId: "a" }, threadIds: ["a"], history: [], future: [] });
  useLayout.setState({ sidebarOpen: true, panelOpen: false, panelThreadId: "a", panelTab: "changes", projectId: null });
});

const active = () => useRouter.getState().route;
const expectActive = (id: string) => expect(active()).toEqual({ view: "thread", threadId: id });
const focusA = () => act(() => useRouter.getState().focusThreadPane("a"));

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

it.each([true])("waits for an emitted plan and preserves manual sidebar choices (team=%s)", (team) => {
  if (team) teamThreads.add("b");
  planThreads.add("b");
  useRouter.setState({ threadIds: ["a", "b"] });
  const view = render(<ThreadWorkspace />);
  act(() => useRouter.getState().focusThreadPane("b"));
  expect(useLayout.getState().panelOpen).toBe(false);

  documents.set("b", [document("discussion", "response")]);
  view.rerender(<ThreadWorkspace />);
  expect(useLayout.getState().panelOpen).toBe(false);
  if (team) {
    documents.set("b", [{ ...document("member-proposal"), runId: "vice-run" }]);
    view.rerender(<ThreadWorkspace />);
    expect(useLayout.getState().panelOpen).toBe(false);
  }
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
      const toggle = within(pane).getByRole("button", { name: "Changes" });
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
