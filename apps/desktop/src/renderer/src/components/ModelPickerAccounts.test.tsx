import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClaudeAccountConnection, Project, ProviderUsage, ThreadSummary } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { useThreadAccounts } from "../lib/use-thread-accounts";
import { PickerAccountRows } from "./ModelPickerAccounts";

const host = vi.hoisted(() => ({ accounts: [] as ClaudeAccountConnection[], usage: {} as Record<string, Promise<unknown>> }));
vi.mock("../lib/rpc", () => ({
  core: {
    delivery: "all",
    setFrameInterest: () => {},
    onPush: () => () => {},
    call: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "claude.accounts.list") return { defaultId: "work", accounts: host.accounts };
      if (method === "providers.usage") return host.usage[String(params["claudeAccountId"])] ?? new Promise(() => {});
      return {};
    }),
  },
}));

const account = (id: string, name: string, status: ClaudeAccountConnection["status"] = "ready"): ClaudeAccountConnection => ({
  id,
  name,
  kind: "managed",
  enabled: status !== "disabled",
  createdAt: 1,
  status,
  email: null,
  organization: null,
  message: null,
});
const usage = (session: number, week: number): ProviderUsage =>
  ({
    status: "available",
    windows: [
      { id: "five_hour", label: "5-hour", usedPercent: 100 - session, remainingPercent: null },
      { id: "seven_day", label: "Weekly", usedPercent: 100 - week, remainingPercent: null },
    ],
  }) as unknown as ProviderUsage;
const project = (accounts?: string[]) =>
  ({
    id: "p1",
    name: "block8-workspace",
    settings: {
      setupScript: null,
      worktreeInclude: [],
      branchPrefix: "openorc",
      detectedConfigs: [],
      claudeAccounts: accounts ? { only: true, accountIds: accounts, defaultId: accounts[0], autoSwitch: false } : null,
    },
  }) as Pick<Project, "id" | "name" | "settings">;

function Rows({ thread, inProject }: { thread: Partial<ThreadSummary>; inProject?: Pick<Project, "id" | "name" | "settings"> }) {
  const accounts = useThreadAccounts({ id: "thread", agent: "claude", activity: "idle", claudeAccountId: "work", ...thread } as ThreadSummary, inProject ?? project());
  return accounts ? <PickerAccountRows section="claude" searching={false} accounts={accounts} moveRowFocus={() => {}} /> : null;
}
const show = (thread: Partial<ThreadSummary> = {}, inProject?: Pick<Project, "id" | "name" | "settings">) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Rows thread={thread} inProject={inProject} />
    </QueryClientProvider>,
  );
const row = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const switches = () => vi.mocked(core.call).mock.calls.filter(([method]) => method === "threads.switchClaudeAccount");

beforeEach(() => {
  host.accounts = [account("work", "Work"), account("personal", "Personal"), account("old", "Old", "signed_out")];
  host.usage = {};
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.mocked(core.call).mockClear();
});

it("lists each account with what it has left, filled in as each read lands, the one in use checked", async () => {
  let answer = (_: unknown) => {};
  host.usage = { work: Promise.resolve(usage(64, 80)), personal: new Promise((resolve) => (answer = resolve)) };
  show();
  await waitFor(() => expect(row("Work").textContent).toContain("64% 5h · 80% wk"));
  expect(row("Work").getAttribute("aria-pressed")).toBe("true");
  expect(row("Personal").textContent).toContain("…");
  await act(async () => answer(usage(10, 30)));
  await waitFor(() => expect(row("Personal").textContent).toContain("10% 5h · 30% wk"));
  const reads = vi
    .mocked(core.call)
    .mock.calls.filter(([method]) => method === "providers.usage")
    .map(([, params]) => params);
  expect(reads).toContainEqual({ provider: "claude", claudeAccountId: "personal", maxAgeMs: 300_000 });
});

it("switches the conversation to another account; one that can't run stays listed with its reason", async () => {
  show();
  expect((await screen.findByRole("button", { name: /^Old/ })).hasAttribute("disabled")).toBe(true);
  expect(row("Old").textContent).toContain("Signed out");
  await act(async () => void fireEvent.click(row("Personal")));
  expect(switches()).toEqual([["threads.switchClaudeAccount", { id: "thread", claudeAccountId: "personal" }]]);
});

it("waits for the turn to end, and leaves an Orcling on its own account", async () => {
  show({ activity: "running" });
  expect((await screen.findByRole("status")).textContent).toBe("Switch accounts when this turn ends.");
  expect(row("Personal").hasAttribute("disabled")).toBe(true);
  cleanup();
  show({ orclingId: "orcling" });
  expect((await screen.findByRole("status")).textContent).toBe("An Orcling keeps its own account.");
});

it("offers only the accounts a project uses, keeps the thread's own apart, and opens the project's accounts", async () => {
  const { useRouter } = await import("../lib/router");
  host.accounts = [account("work", "Work"), account("personal", "Personal"), account("client", "Client")];
  show({}, project(["personal", "client"]));
  const group = await screen.findByRole("group", { name: "Claude account" });
  await waitFor(() => expect(within(group).getAllByRole("button", { pressed: false }).length).toBeGreaterThan(0));
  expect(row("Work").textContent).toContain("Not in this project");
  expect([row("Personal"), row("Client"), row("Work")].every(Boolean)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "block8-workspace’s accounts" }));
  expect(useRouter.getState().route).toEqual({ view: "project", projectId: "p1" });
});
