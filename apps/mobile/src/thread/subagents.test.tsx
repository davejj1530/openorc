// @vitest-environment jsdom
import type { Block } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { router } from "expo-router";
import { afterEach, expect, it, vi } from "vitest";
import { fixtureThreads } from "../home/test-fixtures/threads";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { nativeProps } from "../test-fixtures/react-native";
import { SubagentCards } from "./SubagentCards";
import { SubagentStatusBar } from "./SubagentStatusBar";
import { Card } from "./cards";

vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
it("shows a child Stop notice as quiet text instead of an error card", () => {
  render(<Card runId="parent" block={{ id: "stop", kind: "status", tone: "muted", notice: true, text: "Stopped Checker" }} />);
  expect(nativeProps.get(screen.getByText("Stopped Checker"))?.className).toContain("text-ink-4");
});
const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, stops: [] as unknown[], fail: false, missing: false, offline: false }));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method, params) => {
    if (method === "agents.models") return Promise.resolve([{ agent: "opencode", id: "opencode/deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash Free" }]);
    if (method === "threads.get") return Promise.resolve(mac.missing ? null : child);
    if (method === "subagents.stop") {
      mac.stops.push(params);
      if (mac.fail) return Promise.reject(new Error("The host is offline."));
    }
    return Promise.resolve(null);
  });
  const connected = mac.phone.module.useLinkState;
  return { ...mac.phone.module, useLinkState: () => (mac.offline ? { kind: "disconnected" } : connected()) };
});
afterEach(() => {
  cleanup();
  mac.phone!.module.queryClient.clear();
  mac.stops.length = 0;
  mac.fail = false;
  mac.missing = false;
  mac.offline = false;
  vi.clearAllMocks();
});

const child: ThreadSummary = {
  ...fixtureThreads[0]!,
  id: "child",
  parentRelation: "subagent",
  parentThreadId: "parent",
  model: "haiku",
  subagent: { status: "running", agentType: "Explore", toolCallId: "tool", startedAt: Date.now(), endedAt: null, stoppable: true },
};

it("opens the parent and stops only the chosen child, then replaces Stop with its terminal status", async () => {
  const view = render(<SubagentStatusBar thread={child} onLayout={() => undefined} />, { wrapper: mac.phone!.wrapper });
  expect(view.container.querySelector("input")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open parent" }));
  expect(router.push).toHaveBeenCalledWith({ pathname: "/thread/[id]", params: { id: "parent" } });
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(mac.stops).toEqual([{ threadId: "child" }]));
  view.rerender(<SubagentStatusBar thread={{ ...child, subagent: { ...child.subagent!, status: "stopped", stoppable: false, endedAt: Date.now() } }} onLayout={() => undefined} />);
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(screen.getByText(/Stopped/)).toBeTruthy();
});

it("shows a failed Stop without replacing the read-only controls", async () => {
  mac.fail = true;
  render(<SubagentStatusBar thread={child} onLayout={() => undefined} />, { wrapper: mac.phone!.wrapper });
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The host is offline.");
});

it("keeps a working workflow agent read-only without offering an individual Stop", () => {
  render(<SubagentStatusBar thread={{ ...child, subagent: { ...child.subagent!, stoppable: false } }} onLayout={() => undefined} />, { wrapper: mac.phone!.wrapper });
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(screen.getByRole("button", { name: "Open parent" })).toBeTruthy();
});

it("opens a linked child and hides its card after deletion", async () => {
  const blocks: Extract<Block, { kind: "tool" }>[] = [
    {
      id: "agent",
      kind: "tool",
      name: "Agent",
      input: {},
      done: true,
      isError: false,
      subagent: {
        nativeId: "a",
        threadId: "child",
        title: "Check retry timing",
        group: "Inspect",
        prompt: "Read queue.ts",
        result: "Retries are bounded.",
        status: "completed",
        startedAt: 1,
        endedAt: 2001,
      },
    },
  ];
  render(<SubagentCards blocks={blocks} />, { wrapper: mac.phone!.wrapper });
  expect(screen.getByRole("button", { name: "Open Check retry timing" })).toBeTruthy();
  await waitFor(() => expect(mac.phone!.module.queryClient.isFetching()).toBe(0));
  expect(screen.getByText("Inspect")).toBeTruthy();
  expect(screen.queryByText("Read queue.ts")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open Check retry timing" }));
  expect(router.push).toHaveBeenCalledWith({ pathname: "/thread/[id]", params: { id: "child" } });
  fireEvent.click(screen.getByRole("button", { name: "Details for Check retry timing" }));
  expect(screen.getByText("Read queue.ts")).toBeTruthy();
  expect(screen.getByText("Retries are bounded.")).toBeTruthy();
  mac.missing = true;
  await mac.phone!.module.client.invalidateTags(["thread:child"]);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Open Check retry timing" })).toBeNull());
  expect(screen.queryByText("Inspect")).toBeNull();
});

it("hides Stop while disconnected", () => {
  mac.offline = true;
  render(<SubagentStatusBar thread={child} onLayout={() => undefined} />, { wrapper: mac.phone!.wrapper });
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(screen.getByText(/Working/)).toBeTruthy();
});

it("names a child model from the catalog in its status bar", async () => {
  render(<SubagentStatusBar thread={{ ...child, agent: "opencode", model: "opencode/deepseek-v4.1-flash-free", effort: null }} onLayout={() => undefined} />, { wrapper: mac.phone!.wrapper });
  expect(await screen.findByText("DeepSeek V4.1 Flash Free")).toBeTruthy();
  expect(screen.queryByText("opencode/deepseek-v4.1-flash-free")).toBeNull();
});
