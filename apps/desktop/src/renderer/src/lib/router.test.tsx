import { beforeEach, describe, expect, it } from "vitest";
import { openThread, useRouter } from "./router";
import { useLayout } from "./layout";
import { resizeThreadPair } from "../components/ThreadPaneDivider";

const router = () => useRouter.getState();
const layout = () => useLayout.getState();
beforeEach(() => {
  useRouter.setState({ route: { view: "newthread" }, threadIds: [], history: [], future: [] });
  useLayout.setState({ panelThreadId: null, panelOpen: false, selectedFile: null, selectedChanges: null });
});

describe("thread workspace navigation", () => {
  it("retains the original and rejects duplicate, empty and fourth panes", () => {
    openThread("a");
    for (const id of ["", "a", "b", "b", "c", "d"]) router().addThreadPane(id);
    expect(router().threadIds).toEqual(["a", "b", "c"]);
    expect(router().route).toEqual({ view: "thread", threadId: "a" });
  });
  it("focuses existing panes, replaces the focused pane, and follows history", () => {
    openThread("a");
    router().addThreadPane("b");
    router().addThreadPane("c");
    openThread("b");
    expect(router().threadIds).toEqual(["a", "b", "c"]);
    openThread("d");
    expect(router().threadIds).toEqual(["a", "d", "c"]);
    router().back();
    expect(router().threadIds).toEqual(["a", "b", "c"]);
    router().forward();
    expect(router().threadIds).toEqual(["a", "d", "c"]);
  });
  it("closes the focused pane without replacing a surviving conversation", () => {
    openThread("a");
    router().addThreadPane("b");
    router().addThreadPane("c");
    router().focusThreadPane("b");
    router().closeThreadPane("b");
    expect(router().threadIds).toEqual(["a", "c"]);
    expect(router().route).toEqual({ view: "thread", threadId: "a" });
    router().focusThreadPane("c");
    router().closeOtherThreadPanes();
    expect(router().threadIds).toEqual(["c"]);
    router().closeThreadPane("c");
    expect(router().route).toEqual({ view: "newthread" });
  });
  it("preserves task file context when navigating between non-thread routes", () => {
    router().navigate({ view: "task", taskId: "task", tab: "chat" });
    layout().openFile({ path: "/task.ts", scope: { kind: "task", id: "task" } });
    router().navigate({ view: "task", taskId: "task", tab: "spec" });
    expect(layout().selectedFile?.scope).toEqual({ kind: "task", id: "task" });
    expect(layout().panelOpen).toBe(true);
  });
  it("leaves non-thread routes unchanged and starts fresh on return", () => {
    openThread("a");
    router().addThreadPane("b");
    router().navigate({ view: "task", taskId: "task", tab: "spec" });
    expect(router().threadIds).toEqual([]);
    expect(router().route).toEqual({ view: "task", taskId: "task", tab: "spec" });
    router().closeThreadPane("a");
    router().back();
    expect(router().threadIds).toEqual(["a"]);
  });
});

describe("shared sidebar ownership", () => {
  it("switches to the clicked thread and only toggles closed for its owner", () => {
    openThread("a");
    router().addThreadPane("b");
    layout().toggleThreadPanel("a");
    router().focusThreadPane("b");
    expect(layout().panelThreadId).toBe("a");
    layout().toggleThreadPanel("b");
    expect(layout().panelThreadId).toBe("b");
    expect(layout().panelOpen).toBe(true);
    layout().toggleThreadPanel("b");
    expect(layout().panelOpen).toBe(false);
    layout().toggleThreadPanel("a");
    expect(layout().panelOpen).toBe(true);
  });
});

describe("adjacent pane widths", () => {
  it("conserves width and clamps both sides to the minimum", () => {
    expect(resizeThreadPair(500, 600, 80, 360)).toEqual([580, 520]);
    expect(resizeThreadPair(500, 600, -1000, 360)).toEqual([360, 740]);
    expect(resizeThreadPair(500, 600, 1000, 360)).toEqual([740, 360]);
    expect(resizeThreadPair(100, 100, 90, 360)).toEqual([100, 100]);
  });
});

it("round-trips every Settings section and what a link points at there, while keeping old Settings routes valid", async () => {
  const { routeFromSpec, specFromRoute, SETTINGS_SECTIONS } = await import("./router");
  expect(routeFromSpec("settings")).toEqual({ view: "settings" });
  for (const section of SETTINGS_SECTIONS) expect(routeFromSpec(specFromRoute({ view: "settings", section }))).toEqual({ view: "settings", section });
  for (const provider of ["claude", "codex"] as const) {
    const route = { view: "settings" as const, section: "usage" as const, provider };
    expect(routeFromSpec(specFromRoute(route))).toEqual(route);
  }
  const teamExecution = { view: "settings" as const, section: "general" as const, setting: "team-execution" as const };
  expect(specFromRoute(teamExecution)).toBe("settings:general:team-execution");
  expect(routeFromSpec(specFromRoute(teamExecution))).toEqual(teamExecution);
  expect(routeFromSpec("settings:usage:unknown")).toEqual({ view: "settings", section: "usage" });
  expect(routeFromSpec("settings:general:codex")).toEqual({ view: "settings", section: "general" });
  expect(routeFromSpec("settings:unknown")).toEqual({ view: "settings" });
});

it("round-trips pull request routes and rejects a pull request without a number", async () => {
  const { routeFromSpec, specFromRoute } = await import("./router");
  expect(routeFromSpec("pulls")).toEqual({ view: "pulls" });
  const route = { view: "pull" as const, projectId: "p1", number: 7 };
  expect(specFromRoute(route)).toBe("pull:p1:7");
  expect(routeFromSpec(specFromRoute(route))).toEqual(route);
  expect(routeFromSpec("pull:p1")).toBeNull();
  expect(routeFromSpec("pull:p1:none")).toBeNull();
});
