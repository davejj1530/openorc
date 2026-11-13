import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { shortcuts, useAppShortcuts } from "./app-shortcuts";
import { useFilesTool } from "./files-tool";
import { useLayout } from "./layout";
import { core } from "./rpc";
import { useRouter } from "./router";
import { useUi } from "./ui";
import { queryClient } from "./client";

const updates: RpcParams<"threads.update">[] = [];
const route = () => useRouter.getState().route;
const press = (chord: string, target: Window | Element = window) => fireEvent.keyDown(target, { key: chord.replace("⇧", ""), shiftKey: chord.startsWith("⇧"), metaKey: true });
const inbox = () => useRouter.setState({ route: { view: "inbox" } });

beforeEach(() => {
  queryClient.clear();
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    if (method === "threads.update") updates.push(params as RpcParams<"threads.update">);
    return { id: "t10", pinnedAt: null, archivedAt: null, unread: false, activity: "idle", lastActivityAt: Date.now() } as unknown as RpcResults[M];
  });
  useRouter.setState({ route: { view: "thread", threadId: "t10" }, threadIds: ["t10", "t11"], history: [{ view: "inbox" }], future: [{ view: "memory" }] });
  useUi.getState().setThreadOrder(Array.from({ length: 11 }, (_, i) => `t${i + 1}`));
  useUi.setState({ palette: false, paletteMode: "all" });
  useLayout.setState({ sidebarOpen: true, panelOpen: false, panelThreadId: null, panelRequest: null });
  useFilesTool.setState({ host: null, focus: null, tools: {} });
});

afterEach(() => {
  cleanup();
  updates.length = 0;
  vi.restoreAllMocks();
});

const cases: { chord: string; does: string; given?: () => void; then: () => unknown }[] = [
  { chord: "n", does: "starts a thread in the current project", then: () => expect(route()).toEqual({ view: "newthread", projectId: "project" }) },
  { chord: "b", does: "hides the sidebar", then: () => expect(useLayout.getState().sidebarOpen).toBe(false) },
  { chord: "j", does: "opens the focused thread's panel", then: () => vi.waitFor(() => expect(useLayout.getState()).toMatchObject({ panelThreadId: "t10", panelOpen: true })) },
  { chord: "j", does: "opens the panel without a focused thread", given: inbox, then: () => expect(useLayout.getState()).toMatchObject({ panelThreadId: null, panelOpen: true }) },
  { chord: "[", does: "goes back", then: () => expect(route()).toEqual({ view: "inbox" }) },
  { chord: "]", does: "goes forward", then: () => expect(route()).toEqual({ view: "memory" }) },
  { chord: "\\", does: "closes the other thread panes", then: () => expect(useRouter.getState().threadIds).toEqual(["t10"]) },
  {
    chord: "p",
    does: "opens the Files tool on the focused thread's panel, its search box asked for, the search kept",
    given: () => useFilesTool.setState({ focus: null, tools: { "thread:t10": { query: "app", regex: false, caseSensitive: false } } }),
    then: () => {
      expect(useLayout.getState()).toMatchObject({ panelThreadId: "t10", panelOpen: true, panelRequest: { tab: "file" }, selectedFile: null });
      expect(useFilesTool.getState().focus).not.toBeNull();
      expect(useFilesTool.getState().tools["thread:t10"]?.query).toBe("app");
    },
  },
  {
    chord: "p",
    does: "opens the Files tool on the panel on screen without a focused thread",
    given: () => {
      useRouter.setState({ route: { view: "task", taskId: "task", tab: "chat" } });
      useFilesTool.setState({ host: { kind: "task", id: "task" } });
    },
    then: () => expect(useLayout.getState()).toMatchObject({ panelThreadId: null, panelOpen: true, panelRequest: { tab: "file" } }),
  },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ chord: String(n), does: `opens sidebar thread ${n}`, then: () => expect(route()).toEqual({ view: "thread", threadId: `t${n}` }) })),
  { chord: "⇧[", does: "opens the thread above", then: () => expect(route()).toEqual({ view: "thread", threadId: "t9" }) },
  { chord: "⇧]", does: "opens the thread below", then: () => expect(route()).toEqual({ view: "thread", threadId: "t11" }) },
  { chord: "⇧n", does: "starts a task in the current project", then: () => expect(route()).toEqual({ view: "newtask", projectId: "project" }) },
  { chord: "f", does: "opens message search", then: () => expect(useUi.getState()).toMatchObject({ palette: true, paletteMode: "messages" }) },
  {
    chord: "⇧f",
    does: "opens the focused thread's Files tool, its search box asked for",
    given: () => useFilesTool.setState({ focus: null }),
    then: () => {
      expect(useLayout.getState()).toMatchObject({ panelThreadId: "t10", panelOpen: true, panelRequest: { tab: "file" } });
      expect(useFilesTool.getState().focus).not.toBeNull();
      expect(useUi.getState().palette).toBe(false);
    },
  },
  { chord: "⇧p", does: "pins the focused thread", then: () => vi.waitFor(() => expect(updates).toEqual([{ id: "t10", patch: { pinned: true } }])) },
  { chord: "⇧a", does: "resolves the focused thread", then: () => vi.waitFor(() => expect(updates).toEqual([{ id: "t10", patch: { archived: true } }])) },
  { chord: "⇧u", does: "marks the focused thread unread", then: () => vi.waitFor(() => expect(updates).toEqual([{ id: "t10", patch: { seen: false } }])) },
];

for (const { chord, does, given, then } of cases) {
  it(`⌘${chord} ${does}`, async () => {
    given?.();
    renderHook(() => useAppShortcuts("project"));
    expect(press(chord), "the shortcut claims the key").toBe(false);
    await vi.waitFor(then);
  });
}

it("has a case for every chord the window binds", () => {
  expect([...new Set(cases.map((c) => c.chord))].sort()).toEqual([...shortcuts.keys()].sort());
});

it.each(["j", "p", "⇧f", "⇧p", "⇧a"])("does not apply ⌘%s to a subagent", async (chord) => {
  vi.mocked(core.call).mockResolvedValue({ id: "t10", parentRelation: "subagent", parentThreadId: "parent" });
  renderHook(() => useAppShortcuts("project"));
  press(chord);
  await Promise.resolve();
  expect(useLayout.getState().panelOpen).toBe(false);
  expect(useFilesTool.getState()).toMatchObject({ focus: null, tools: {} });
  expect(vi.mocked(core.call).mock.calls.some(([method]) => method === "threads.update")).toBe(false);
});

it("takes Ctrl as ⌘, and leaves keys without either to typing", () => {
  renderHook(() => useAppShortcuts("project"));
  expect(fireEvent.keyDown(window, { key: "b" }), "plain B is typing").toBe(true);
  expect(useLayout.getState().sidebarOpen).toBe(true);
  expect(fireEvent.keyDown(window, { key: "b", ctrlKey: true })).toBe(false);
  expect(useLayout.getState().sidebarOpen).toBe(false);
});

it("leaves a number past the sidebar's threads, and thread actions with no focused thread, to the page", () => {
  inbox();
  useUi.getState().setThreadOrder(["t1", "t2", "t3"]);
  renderHook(() => useAppShortcuts("project"));
  expect(press("4")).toBe(true);
  expect(press("⇧p")).toBe(true);
  expect(route()).toEqual({ view: "inbox" });
  expect(core.call).not.toHaveBeenCalled();
});

it("leaves ⌘P to the page when no conversation's panel is on screen", () => {
  inbox();
  renderHook(() => useAppShortcuts("project"));
  expect(press("p")).toBe(true);
  expect(useLayout.getState()).toMatchObject({ panelOpen: false, panelRequest: null });
  expect(useFilesTool.getState().focus).toBeNull();
});

it("leaves a ⌘[ that something below the window already handled, so an editor's indent doesn't also go back", () => {
  renderHook(() => useAppShortcuts("project"));
  const editor = document.body.appendChild(document.createElement("div"));
  editor.addEventListener("keydown", (event) => event.preventDefault());
  press("[", editor);
  expect(useRouter.getState()).toMatchObject({ route: { view: "thread", threadId: "t10" }, history: [{ view: "inbox" }] });
  editor.remove();
});

it("does not queue a file panel when a subagent path is opened", async () => {
  vi.mocked(core.call).mockResolvedValue({ id: "t10", parentRelation: "subagent", parentThreadId: "parent" });
  useLayout.setState({ selectedFile: null });
  useLayout.getState().openFile({ scope: { kind: "thread", id: "t10" }, path: "src/main.ts" });
  await Promise.resolve();
  expect(useLayout.getState()).toMatchObject({ panelOpen: false, panelThreadId: null, selectedFile: null, panelRequest: null });
});

it("numbers and steps through the same visible rows, including subagents", () => {
  useUi.getState().setThreadOrder(["parent", "child", "started"]);
  renderHook(() => useAppShortcuts("project"));
  press("2");
  expect(route()).toEqual({ view: "thread", threadId: "child" });
  press("⇧]");
  expect(route()).toEqual({ view: "thread", threadId: "started" });
});
