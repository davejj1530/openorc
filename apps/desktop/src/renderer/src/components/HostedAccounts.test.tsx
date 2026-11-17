import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ThreadSummary } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => {
  const state: { thread: ThreadSummary | null; reads: string[]; asked: unknown[]; cloud: unknown } = { thread: null, reads: [], asked: [], cloud: null };
  return state;
});
vi.mock("../lib/rpc", () => ({
  core: {
    delivery: "all",
    setFrameInterest: () => {},
    onPush: () => () => {},
    call: vi.fn(async (method: string, params: { cloud?: true }) => {
      host.reads.push(method);
      if (method === "threads.get") return host.thread;
      if (method === "claude.accounts.list") return { defaultId: "personal", accounts: [{ id: "personal", name: "Personal", enabled: true, status: "ready" }] };
      if (method === "providers.usage") host.asked.push(params);
      if (method === "providers.usage" && params.cloud) return host.cloud;
      if (method === "providers.usage") return { status: "available", windows: [{ id: "seven_day", label: "Weekly", usedPercent: 36, remainingPercent: 64 }] };
      return [];
    }),
  },
}));

import { queryClient } from "../lib/client";
import { useRouter } from "../lib/router";
import { useThreadAccounts } from "../lib/use-thread-accounts";
import { AccountUsage } from "./AccountUsage";
import { cloudReviewThread, localReviewThread } from "./test-fixtures/hosted-review";

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
const settled = () => waitFor(() => expect(queryClient.isFetching()).toBe(0));

beforeEach(() => {
  host.reads.length = 0;
  host.asked.length = 0;
  host.cloud = { status: "unavailable", windows: [], credits: [], plan: null, context: "OpenOrc Cloud" };
  host.thread = { ...cloudReviewThread, agent: "claude" };
  useRouter.setState({ route: { view: "thread", threadId: host.thread.id } });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

it("does not read or offer Mac accounts for a cloud Claude conversation", async () => {
  const { result } = renderHook(() => useThreadAccounts(host.thread, null), { wrapper });
  await settled();
  expect(host.reads).not.toContain("claude.accounts.list");
  expect(result.current).toBeUndefined();
});

it("keeps the Mac account picker for a local Claude conversation", async () => {
  host.thread = { ...localReviewThread, agent: "claude" };
  const { result } = renderHook(() => useThreadAccounts(host.thread, null), { wrapper });
  await waitFor(() => expect(result.current?.current).toBe("personal"));
  expect(host.reads).toContain("claude.accounts.list");
  expect(result.current?.accounts.map((account) => account.name)).toEqual(["Personal"]);
});

it.each(["claude", "codex"] as const)("shows the cloud %s sign-in's last reading, never this Mac's accounts", async (agent) => {
  host.thread = { ...cloudReviewThread, agent };
  host.cloud = {
    status: "available",
    windows: [{ id: "seven_day", label: "Weekly", usedPercent: 81, remainingPercent: 19, resetsAt: null, observedAt: Date.now() }],
    credits: [],
    plan: "Max",
    context: "OpenOrc Cloud",
  };
  render(<AccountUsage />, { wrapper });
  expect(await screen.findByText("19%")).toBeTruthy();
  expect(host.asked).toEqual([{ provider: agent, cloud: true }]);
  expect(host.reads).not.toContain("claude.accounts.list");
  expect(screen.queryByText("64%")).toBeNull();
});

it("shows nothing for a cloud thread whose sign-in has no reading yet, rather than a guess", async () => {
  render(<AccountUsage />, { wrapper });
  await settled();
  expect(host.asked).toEqual([{ provider: "claude", cloud: true }]);
  expect(screen.queryByRole("button")).toBeNull();
});

it("keeps the local account's reported allowance in the footer", async () => {
  host.thread = { ...localReviewThread, id: cloudReviewThread.id, agent: "claude" };
  render(<AccountUsage />, { wrapper });
  expect(await screen.findByText("64%")).toBeTruthy();
  expect(host.reads).toContain("claude.accounts.list");
  expect(host.reads).toContain("providers.usage");
});
