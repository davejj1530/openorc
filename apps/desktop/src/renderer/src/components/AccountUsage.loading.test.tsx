import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ProviderUsage } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishComposerAccount, useComposerAccount } from "../lib/composer-account";
import { useRouter } from "../lib/router";
import { AccountUsage } from "./AccountUsage";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call: mocks.call, onReady: () => {}, onPush: () => () => {} } }));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));

const now = Date.now();
const codex: ProviderUsage = {
  provider: "codex",
  status: "available",
  context: "Example account",
  source: "Codex",
  plan: "Pro",
  checkedAt: now,
  refreshedAt: now,
  message: null,
  windows: [{ id: "codex:secondary", label: "7-day window", usedPercent: 36, remainingPercent: 64, resetsAt: now + 86_400_000, observedAt: now, exhausted: false }],
  credits: [],
  accountUrl: "https://chatgpt.com",
  localRuns: 1,
};
let client: QueryClient;
let readUsage: (provider: string, accountId?: string) => Promise<ProviderUsage>;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  useRouter.setState({ route: { view: "newthread" } });
  useComposerAccount.setState({ chosen: null });
  publishComposerAccount({ agent: "codex" });
  readUsage = async () => codex;
  mocks.call.mockImplementation(async (method, params) => {
    if (method === "providers.usage") return readUsage(params.provider, params.claudeAccountId);
    if (method === "claude.accounts.list")
      return {
        defaultId: "work",
        accounts: [
          { id: "work", name: "Work", enabled: true },
          { id: "client", name: "Client", enabled: true },
        ],
      };
    if (method === "agents.availability") return ["codex", "claude"].map((id) => ({ id, state: "ready" }));
    return {};
  });
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  return render(
    <QueryClientProvider client={client}>
      <AccountUsage />
    </QueryClientProvider>,
  );
}

it("shows the known current account immediately and fills each other account without waiting for the slowest", async () => {
  let finishWork!: (report: ProviderUsage) => void;
  const work = new Promise<ProviderUsage>((resolve) => {
    finishWork = resolve;
  });
  const pending = new Promise<ProviderUsage>(() => {});
  readUsage = async (provider, id) => {
    if (provider === "codex") return codex;
    return id === "work" ? work : pending;
  };
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Codex: 64% left this week" }));
  const row = await screen.findByRole("row", { name: /Codex/ }, { timeout: 200 });
  expect(within(row).getByText("64% left")).toBeTruthy();
  expect(within(await screen.findByRole("row", { name: /Claude · Work/ })).getByText("Reading usage")).toBeTruthy();
  await act(async () => finishWork({ ...codex, provider: "claude", claudeAccountId: "work", windows: [{ ...codex.windows[0]!, remainingPercent: 41, usedPercent: 59 }] }));
  expect(within(await screen.findByRole("row", { name: /Claude · Work/ })).getByText("41% left")).toBeTruthy();
  expect(within(screen.getByRole("row", { name: /Claude · Client/ })).getByText("Reading usage")).toBeTruthy();
  expect(mocks.call.mock.calls.filter(([method, params]) => method === "providers.usage" && params.provider === "codex")).toHaveLength(1);
});

it("shows the current account before discovery finishes", async () => {
  const pending = new Promise(() => {});
  mocks.call.mockImplementation(async (method) => (method === "providers.usage" ? codex : pending));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Codex: 64% left this week" }));
  expect(within(await screen.findByRole("row", { name: /Codex/ }, { timeout: 200 })).getByText("64% left")).toBeTruthy();
});

it("reopens from the shared cache without another provider read", async () => {
  const rendered = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Codex: 64% left this week" }));
  await screen.findByRole("row", { name: /Claude · Client.*64%/ });
  const calls = mocks.call.mock.calls.filter(([method]) => method === "providers.usage");
  expect(calls).toHaveLength(3);
  expect(calls.every(([, params]) => params.maxAgeMs === 60_000)).toBe(true);
  rendered.unmount();
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Codex: 64% left this week" }));
  expect(within(await screen.findByRole("row", { name: /Claude · Client/ }, { timeout: 200 })).getByText("64% left")).toBeTruthy();
  expect(mocks.call.mock.calls.filter(([method]) => method === "providers.usage")).toHaveLength(3);
});

it("keeps successful rows visible when one account fails", async () => {
  readUsage = async (provider) => {
    if (provider === "claude") throw new Error("Offline");
    return codex;
  };
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Codex: 64% left this week" }));
  await waitFor(() => expect(within(screen.getByRole("row", { name: /Claude · Work/ })).getByText("Couldn’t read usage")).toBeTruthy());
  expect(within(screen.getByRole("row", { name: /Codex/ })).getByText("64% left")).toBeTruthy();
});

it("does not carry the previous account's allowance into a new selection", async () => {
  const pending = new Promise<ProviderUsage>(() => {});
  readUsage = async (provider) => (provider === "codex" ? codex : pending);
  mount();
  await screen.findByRole("button", { name: "Codex: 64% left this week" });
  act(() => publishComposerAccount({ agent: "claude", claudeAccountId: "work" }));
  expect(screen.queryByRole("button", { name: /64% left this week/ })).toBeNull();
});

it("omits disabled accounts and uninstalled providers without requesting their usage", async () => {
  mocks.call.mockImplementation(async (method) => {
    if (method === "providers.usage") return codex;
    if (method === "agents.availability")
      return [
        { id: "codex", state: "ready" },
        { id: "claude", state: "ready" },
        { id: "antigravity", state: "not_found" },
      ];
    if (method === "claude.accounts.list")
      return {
        defaultId: "work",
        accounts: [
          { id: "work", name: "Work", enabled: true },
          { id: "disabled", name: "Disabled account", enabled: false },
        ],
      };
    return {};
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Codex: 64% left this week" }));
  await screen.findByRole("row", { name: /Claude.*64% left/ });
  expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3);
  const reads = mocks.call.mock.calls.filter(([method]) => method === "providers.usage").map(([, params]) => [params.provider, params.claudeAccountId]);
  expect(reads).toEqual([
    ["codex", undefined],
    ["claude", "work"],
  ]);
});
