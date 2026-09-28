import { describe, expect, it } from "vitest";
import type { PanelTab } from "./layout";
import { closedTools, visibleTabs } from "./panel-tabs";

const thread: PanelTab[] = ["changes", "plan", "terminal", "browser", "tasks", "checkpoints", "commits", "memory"];

describe("visibleTabs", () => {
  it("shows only content tabs whose signal is true", () => {
    expect(visibleTabs(thread, { changes: true, plan: false, checkpoints: true }, [], null)).toEqual(["changes", "checkpoints"]);
  });

  it("keeps the pinned tab even with nothing in it", () => {
    expect(visibleTabs(thread, { changes: true }, [], "memory")).toEqual(["changes", "memory"]);
    expect(visibleTabs(thread, {}, [], "terminal")).toEqual(["terminal"]);
  });

  it("leaves content unfiltered without signals and keeps tabs that have none", () => {
    expect(visibleTabs(["changes", "terminal", "task", "commits"], null, [], null)).toEqual(["changes", "task", "commits"]);
  });
});

describe("closedTools", () => {
  it("offers the context's tools that are not showing", () => {
    expect(closedTools(thread, ["changes", "terminal"])).toEqual(["browser"]);
    expect(closedTools(["changes"], [])).toEqual([]);
  });
});
