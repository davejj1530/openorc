import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { shortcuts, useAppShortcuts } from "./app-shortcuts";
import { useFilesTool } from "./files-tool";
import { useLayout } from "./layout";
import { core } from "./rpc";
import { useRouter } from "./router";
import { useUi } from "./ui";

const updates: RpcParams<"threads.update">[] = [];
const route = () => useRouter.getState().route;
const press = (chord: string, target: Window | Element = window) => fireEvent.keyDown(target, { key: chord.replace("⇧", ""), shiftKey: chord.startsWith("⇧"), metaKey: true });
const inbox = () => useRouter.setState({ route: { view: "inbox" } });

beforeEach(() => {
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    if (method === "threads.update") updates.push(params as RpcParams<"threads.update">);
    return { id: "t10", pinnedAt: null, archivedAt: null, unread: false } as unknown as RpcResults[M];
  });
  useRouter.setState({ route: { view: "thread", threadId: "t10" }, threadIds: ["t10", "t11"], history: [{ view: "inbox" }], future: [{ view: "memory" }] });
  useUi.setState({ threadOrder: Array.from({ length: 11 }, (_, i) => `t${i + 1}`), palette: false, paletteMode: "all" });
  useLayout.setState({ sidebarOpen: true, panelOpen: false, panelThreadId: null, panelRequest: null, sidebarFilter: "active" });
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
  { chord: "j", does: "opens the focused thread's panel", then: () => expect(useLayout.getState()).toMatchObject({ panelThreadId: "t10", panelOpen: true }) },
  { chord: "j", does: "opens the panel without a focused thread", given: inbox, then: () => expect(useLayout.getState()).toMatchObject({ panelThreadId: null, panelOpen: true }) },
  { chord: "[", does: "goes back", then: () => expect(route()).toEqual({ view: "inbox" }) },
  { chord: "]", does: "goes forward", then: () => expect(route()).toEqual({ view: "memory" }) },
  { chord: "\\", does: "closes the other thread panes", then: () => expect(useRouter.getState().threadIds).toEqual(["t10"]) },
  {
    chord: "p",
    does: "opens the Files tool on the focused thread's panel, finding by name",
    given: () => useFilesTool.setState({ tools: { "thread:t10": { mode: "contents", names: "", contents: { text: "", regex: false, caseSensitive: false } } } }),
    then: () => {
      expect(useLayout.getState()).toMatchObject({ panelThreadId: "t10", panelOpen: true, panelRequest: { tab: "file" }, selectedFile: null });
      expect(useFilesTool.getState().tools["thread:t10"]?.mode).toBe("names");
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
    does: "opens the focused thread's Files tool on what files contain",
    then: () => {
      expect(useLayout.getState()).toMatchObject({ panelThreadId: "t10", panelOpen: true, panelRequest: { tab: "file" } });
      expect(useFilesTool.getState().tools["thread:t10"]?.mode).toBe("contents");
      expect(useUi.getState().palette).toBe(false);
    },
  },
  { chord: "⇧o", does: "switches the sidebar to orcmode", then: () => expect(useLayout.getState().sidebarFilter).toBe("orc") },
  { chord: "⇧p", does: "pins the focused thread", then: () => vi.waitFor(() => expect(updates).toEqual([{ id: "t10", patch: { pinned: true } }])) },
  { chord: "⇧a", does: "archives the focused thread", then: () => vi.waitFor(() => expect(updates).toEqual([{ id: "t10", patch: { archived: true } }])) },
  { chord: "⇧u", does: "marks the focused thread unread", then: () => vi.waitFor(() => expect(updates).toEqual([{ id: "t10", patch: { seen: false } }])) },
];

for (const { chord, does, given, then } of cases) {
  it(`⌘${chord} ${does}`, async () => {
    given?.();
    renderHook(() => useAppShortcuts("project"));
    expect(press(chord), "the shortcut claims the key").toBe(false);
    await then();
  });
}

it("has a case for every chord the window binds", () => {
  expect([...new Set(cases.map((c) => c.chord))].sort()).toEqual([...shortcuts.keys()].sort());
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
  useUi.setState({ threadOrder: ["t1", "t2", "t3"] });
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
