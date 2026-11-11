import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UsageHistory, UsageTotals } from "@openorc/protocol";
import { useRouter } from "../lib/router";
import { UsageDashboard, UsageHistoryContent } from "./settings-usage-dashboard";
import { usageBoundaries } from "./usage-history-presentation";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call: mocks.call, onReady: () => {}, onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const total: UsageTotals = { costUsd: null, inputTokens: 200, outputTokens: 20, cacheReadTokens: 800, cacheWriteTokens: 0, sessions: 1, unpricedSessions: 1, unreportedTokenSessions: 0 };
const history: UsageHistory = {
  total,
  agents: [{ ...total, agent: "codex" }],
  models: [{ ...total, agent: "codex", model: "example-model" }],
  buckets: [1, 2].map((start) => ({ start, total, agents: [{ ...total, agent: "codex" }] })),
};

beforeEach(() => {
  useRouter.setState({ route: { view: "settings", section: "usage" }, history: [], future: [] });
  mocks.call.mockImplementation(async (method, params) => {
    if (method === "usage.history") return history;
    if (method === "app.settings.get") return { enabledHarnesses: ["codex"] };
    if (method === "providers.usage")
      return {
        provider: params.provider,
        status: "available",
        context: "Example account",
        source: "Example",
        plan: "Pro",
        checkedAt: Date.now(),
        refreshedAt: Date.now(),
        message: null,
        windows: [],
        credits: [],
        accountUrl: "",
        localRuns: 1,
      };
    return {};
  });
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  return render(
    <QueryClientProvider client={client}>
      <UsageDashboard active />
    </QueryClientProvider>,
  );
}

it("starts with costs, labels missing prices, and switches to measured tokens and existing limits", async () => {
  mount();
  const summary = await screen.findByRole("region", { name: "Usage total" });
  expect(within(summary).getByText("Cost unavailable for 1 session")).toBeTruthy();
  expect(summary.textContent).not.toContain("$0.00");
  fireEvent.click(screen.getByRole("radio", { name: "Tokens" }));
  expect(within(summary).getAllByText("1K").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("radio", { name: "Limits" }));
  expect(await screen.findByRole("region", { name: "Codex usage" })).toBeTruthy();
});

it("shows a Codex API estimate when token pricing is available", () => {
  const priced = { ...total, costUsd: 0.68, unpricedSessions: 0 };
  render(<UsageHistoryContent data={{ ...history, total: priced, agents: [{ ...priced, agent: "codex" }] }} metric="cost" period="30d" onAgent={() => {}} />);
  const summary = within(screen.getByRole("region", { name: "Usage total" }));
  expect(summary.getByText("1 session · API estimate")).toBeTruthy();
  expect(summary.getAllByText("$0.68")).toHaveLength(2);
  expect(summary.queryByText(/Cost unavailable/)).toBeNull();
});

it("preserves the day breakdown across period and agent filters and exposes keyboard chart inspection", async () => {
  mount();
  await screen.findByRole("region", { name: "Usage breakdown" });
  fireEvent.click(screen.getByRole("radio", { name: "Day" }));
  fireEvent.click(screen.getByRole("radio", { name: "24 hours" }));
  await waitFor(() => expect(mocks.call.mock.calls.some(([method, params]) => method === "usage.history" && params.boundaries.length === 25)).toBe(true));
  expect(screen.getByRole("radio", { name: "Hour" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.change(screen.getByRole("combobox", { name: "Filter usage by agent" }), { target: { value: "codex" } });
  await waitFor(() => expect(mocks.call.mock.calls.some(([method, params]) => method === "usage.history" && params.agent === "codex")).toBe(true));
  const chart = screen.getByRole("group", { name: "Cost trend" });
  fireEvent.focus(chart);
  fireEvent.keyDown(chart, { key: "ArrowLeft" });
  expect(within(chart).getByRole("status").textContent).toContain("Codex");
});

it("reuses recently loaded periods and agents when switching back", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_794_000_000_000);
  try {
    mount();
    await screen.findByRole("region", { name: "Usage total" });
    clock.mockReturnValue(1_794_000_001_000);
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "7 days" })));
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "30 days" })));
    expect(mocks.call.mock.calls.filter(([method]) => method === "usage.history")).toHaveLength(2);
    await act(async () => fireEvent.change(screen.getByRole("combobox", { name: "Filter usage by agent" }), { target: { value: "codex" } }));
    await act(async () => fireEvent.change(screen.getByRole("combobox", { name: "Filter usage by agent" }), { target: { value: "all" } }));
    expect(mocks.call.mock.calls.filter(([method]) => method === "usage.history")).toHaveLength(3);
  } finally {
    clock.mockRestore();
  }
});

it("opens Limits when a provider recovery link arrives while the dashboard is mounted", async () => {
  mount();
  await screen.findByRole("region", { name: "Usage total" });
  act(() => useRouter.setState({ route: { view: "settings", section: "usage", provider: "codex" } }));
  expect(screen.getByRole("radio", { name: "Limits" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("region", { name: "Codex usage" })).toBeTruthy();
});

it("shows a recoverable error instead of zero usage when history fails", async () => {
  let fails = true;
  mocks.call.mockImplementation(async (method) => {
    if (method === "usage.history") {
      if (fails) throw Error("Unavailable");
      return history;
    }
    return {};
  });
  mount();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Usage total" })).toBeNull();
  fails = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("region", { name: "Usage total" })).toBeTruthy();
});

it("shows unavailable tokens separately from an empty period", () => {
  const unknown = { ...history, total: { ...total, unreportedTokenSessions: 1 } };
  render(<UsageHistoryContent data={unknown} metric="tokens" period="30d" onAgent={() => {}} />);
  expect(within(screen.getByRole("region", { name: "Usage total" })).getByText("Not reported")).toBeTruthy();
  expect(screen.getByText("Tokens not reported for 1 session")).toBeTruthy();
});

it("builds complete local calendar ranges and a rolling 24-hour range", () => {
  const now = new Date(2026, 10, 9, 13, 45).getTime();
  const days = usageBoundaries("30d", now);
  expect(days).toHaveLength(31);
  expect(new Date(days[0]!).getHours()).toBe(0);
  expect(new Date(days[29]!).getDate()).toBe(9);
  expect(days[30]).toBe(now);
  const hours = usageBoundaries("24h", now);
  expect(hours).toHaveLength(25);
  expect(hours[24]! - hours[0]!).toBe(86_400_000);
});
