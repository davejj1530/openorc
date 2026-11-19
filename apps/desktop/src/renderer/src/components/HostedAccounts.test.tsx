import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ThreadSummary } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => {
  const state: { thread: ThreadSummary | null; reads: string[]; asked: unknown[]; cloud: unknown; account: unknown; features: Record<string, unknown>; updates: unknown[] } = {
    thread: null,
    reads: [],
    asked: [],
    cloud: null,
    account: null,
    features: {},
    updates: [],
  };
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
      if (method === "account.status") return host.account;
      if (method === "hosted.capabilities") return { version: 1, features: host.features };
      if (method === "threads.update") host.updates.push(params);
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
  host.account = null;
  host.features = {};
  host.updates.length = 0;
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
  expect(screen.getByRole("button", { name: "OpenOrc Cloud: 19% left this week" })).toBeTruthy();
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

const signedIn = (signIns: unknown[]) => ({
  state: "signed-in",
  email: "ada@example.com",
  name: "Ada",
  image: null,
  reach: "live",
  plan: { pro: true, standing: "live", at: Date.now() + 86_400_000 },
  hours: { leftSeconds: 3600, monthly: null, packsLeftSeconds: 3600 },
  sandbox: null,
  signIns,
  agentAccounts: true,
  signingIn: {},
  github: null,
  connectingGithub: null,
  paying: null,
  projects: [],
  error: null,
});
const claudeAccounts = [
  { agent: "claude", provider: "anthropic", label: "Claude Max", ended: false, id: "personal", name: "Personal", isDefault: true, way: "token" },
  { agent: "claude", provider: "anthropic", label: "Claude Max", ended: true, id: "work", name: "Work", isDefault: false, way: "token" },
  { agent: "codex", provider: "openai", label: "ChatGPT Pro", ended: false, id: "pro", name: "ChatGPT Pro", isDefault: true, way: "code" },
];

it("offers a cloud thread the person's accounts for its agent, the one it runs on checked, and changes it for the next turns", async () => {
  host.features = { agentAccounts: { available: true } };
  host.account = signedIn(claudeAccounts);
  host.thread = { ...cloudReviewThread, agent: "claude", activity: "idle", cloudAccountId: "work" };
  const { result } = renderHook(() => useThreadAccounts(host.thread, null), { wrapper });
  await waitFor(() => expect(result.current?.current).toBe("work"));
  expect(result.current).toMatchObject({ cloud: true, section: "claude", manage: "cloud", blocked: undefined });
  expect(result.current?.accounts).toEqual([
    { id: "personal", name: "Personal", status: "ready" },
    { id: "work", name: "Work", status: "signed_out" },
  ]);
  expect(result.current?.usage?.("personal")).toEqual({ provider: "claude", cloud: true, cloudAccountId: "personal" });
  expect(host.reads).not.toContain("claude.accounts.list");
  result.current?.choose("personal");
  await waitFor(() => expect(host.updates).toEqual([{ id: cloudReviewThread.id, patch: { cloudAccountId: "personal" } }]));
});

it("shows a teammate's account in a shared cloud thread as the person's own default, and holds a change while a turn runs", async () => {
  host.features = { agentAccounts: { available: true } };
  host.account = signedIn(claudeAccounts);
  host.thread = { ...cloudReviewThread, agent: "claude", activity: "running", cloudAccountId: "someone-elses" };
  const { result } = renderHook(() => useThreadAccounts(host.thread, null), { wrapper });
  await waitFor(() => expect(result.current?.current).toBe("personal"));
  expect(result.current?.blocked).toBe("Switch accounts when this turn ends.");
});

it("offers no cloud accounts where the thread's server keeps one sign-in per agent", async () => {
  host.account = signedIn(claudeAccounts);
  const { result } = renderHook(() => useThreadAccounts(host.thread, null), { wrapper });
  await settled();
  expect(result.current).toBeUndefined();
});

it("reads the usage of the account a cloud thread runs on, by its name", async () => {
  host.features = { agentAccounts: { available: true } };
  host.account = signedIn(claudeAccounts);
  host.thread = { ...cloudReviewThread, agent: "codex" };
  host.cloud = {
    status: "available",
    windows: [{ id: "seven_day", label: "Weekly", usedPercent: 30, remainingPercent: 70, resetsAt: null, observedAt: Date.now() }],
    credits: [],
    plan: "Pro",
    context: "OpenOrc Cloud",
  };
  render(<AccountUsage />, { wrapper });
  expect(await screen.findByRole("button", { name: "OpenOrc Cloud · ChatGPT Pro: 70% left this week" })).toBeTruthy();
  expect(host.asked).toContainEqual({ provider: "codex", cloud: true, cloudAccountId: "pro" });
});
