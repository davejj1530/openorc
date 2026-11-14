import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HOSTED_REASONS, type ThreadSummary } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => {
  const state: { thread: ThreadSummary | null; reads: string[] } = { thread: null, reads: [] };
  return state;
});
vi.mock("../lib/rpc", () => ({
  core: {
    delivery: "all",
    setFrameInterest: () => {},
    onPush: () => () => {},
    call: vi.fn(async (method: string) => {
      host.reads.push(method);
      if (method === "threads.get") return host.thread;
      if (method === "claude.accounts.list") return { defaultId: "personal", accounts: [{ id: "personal", name: "Personal", enabled: true, status: "ready" }] };
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

it.each(["claude", "codex"] as const)("does not present Mac allowance as the cloud %s account's usage", async (agent) => {
  host.thread = { ...cloudReviewThread, agent };
  render(<AccountUsage />, { wrapper });
  await settled();
  expect(host.reads).not.toContain("claude.accounts.list");
  expect(host.reads).not.toContain("providers.usage");
  expect(screen.queryByText("64%")).toBeNull();
  const usage = screen.getByRole("button", { name: "Usage" });
  expect(usage.hasAttribute("disabled")).toBe(true);
  expect(screen.queryByText(HOSTED_REASONS.usage)).toBeNull();
  await act(async () => usage.parentElement?.focus());
  expect(await screen.findByText(HOSTED_REASONS.usage)).toBeTruthy();
});

it("keeps the local account's reported allowance in the footer", async () => {
  host.thread = { ...localReviewThread, id: cloudReviewThread.id, agent: "claude" };
  render(<AccountUsage />, { wrapper });
  expect(await screen.findByText("64%")).toBeTruthy();
  expect(host.reads).toContain("claude.accounts.list");
  expect(host.reads).toContain("providers.usage");
});
