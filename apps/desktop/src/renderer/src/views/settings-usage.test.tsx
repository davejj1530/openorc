import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderUsage } from "@openorc/protocol";
import { ResetControls } from "./settings-resets";
import { ProviderUsageOverview } from "./settings-usage";

const mocks = vi.hoisted(() => ({ call: vi.fn(), open: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call: mocks.call, onInvalidate: () => {}, onReady: () => {} } }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const report: ProviderUsage = {
  provider: "codex",
  context: "ChatGPT · pro · fixture@example.test",
  status: "available",
  source: "Fixture",
  checkedAt: 1800000000000,
  refreshedAt: 1800000000000,
  message: null,
  windows: [],
  credits: [],
  accountUrl: "https://example.test/usage",
  localRuns: 0,
  resets: {
    availableCount: 2,
    credits: [{ id: "fixture-credit", expiresAt: 1800001000000, title: "Full reset", description: "Restore eligible fixture windows" }],
    redemption: "available",
    confirmationToken: "snapshot",
  },
};
function mount(content: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}>{content}</QueryClientProvider>) };
}

it("requires confirmation, supports cancel and prevents duplicate redemption while pending", async () => {
  let resolve!: (result: unknown) => void;
  mocks.call.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  mount(<ResetControls report={report} stale={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Use reset" }));
  expect(screen.getByRole("dialog").textContent).toContain(report.context);
  expect(screen.getByRole("dialog").textContent).toContain("Restore eligible fixture windows");
  expect(mocks.call).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.call).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Use reset" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
  await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1));
  const input = mocks.call.mock.calls[0]![1];
  expect(input).toMatchObject({ creditId: "fixture-credit", confirmationToken: "snapshot" });
  expect(input.attemptId).toMatch(/^[0-9a-f-]{36}$/);
  expect(screen.getByRole("button", { name: "Checking reset…" }).hasAttribute("disabled")).toBe(true);
  await act(async () => resolve({ outcome: "reset", message: "Reset used", usage: { ...report, status: "error", resets: undefined } }));
  expect(screen.getByRole("status").textContent).toBe("Reset used");
});

it("reuses the same attempt after a lost response and resumes an attempt supplied after restart", async () => {
  mocks.call.mockRejectedValueOnce(new Error("Transport lost")).mockResolvedValue({ outcome: "alreadyRedeemed", message: "Already used", usage: report });
  mount(<ResetControls report={report} stale={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Use reset" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry reset attempt" }));
  await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2));
  expect(mocks.call.mock.calls[0]![1]).toEqual(mocks.call.mock.calls[1]![1]);
  cleanup();
  mount(<ResetControls report={{ ...report, resets: { ...report.resets!, pendingAttempt: { id: "persisted-id", creditId: "fixture-credit" } } }} stale={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry reset attempt" }));
  await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(3));
  expect(mocks.call.mock.calls[2]![1].attemptId).toBe("persisted-id");
});

it("keeps a terminal outcome visible if post-redemption usage refresh fails", async () => {
  mocks.call.mockResolvedValue({ outcome: "reset", message: "Reset used; refresh usage", usage: { ...report, status: "error", resets: undefined } });
  const view = mount(<ResetControls report={report} stale={false} disclosure />);
  fireEvent.click(screen.getByRole("button", { name: "Use reset" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
  await screen.findByRole("status");
  view.rerender(
    <QueryClientProvider client={view.client}>
      <ResetControls report={{ ...report, status: "error", resets: undefined }} stale disclosure />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("status").textContent).toContain("Reset used");
  expect(screen.queryByRole("button", { name: "Use reset" })).toBeNull();
});

it("refreshes only the opened provider once on return and does not infer a Claude reset count", async () => {
  Object.defineProperty(window, "openorc", { value: { openExternal: mocks.open }, configurable: true });
  mocks.call.mockImplementation(async (method, input) =>
    method === "memory.settings.get"
      ? {}
      : {
          ...report,
          provider: input.provider,
          resets: input.provider === "claude" ? { availableCount: null, credits: null, redemption: "external", message: "Use your free reset in Claude Settings → Usage." } : report.resets,
        },
  );
  mount(<ProviderUsageOverview active />);
  const claude = await screen.findByRole("region", { name: "Claude Code usage" });
  await within(claude).findByText("Use your free reset in Claude Settings → Usage.");
  expect(within(claude).queryByText(/resets available/)).toBeNull();
  expect(within(claude).queryByRole("button", { name: "Use reset" })).toBeNull();
  const reads = (provider: string) => mocks.call.mock.calls.filter(([method, input]) => method === "providers.usage" && input.provider === provider).length;
  const before = { claude: reads("claude"), codex: reads("codex") };
  fireEvent.click(within(claude).getByRole("button", { name: "Open usage" }));
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(reads("claude")).toBe(before.claude + 1));
  fireEvent(window, new Event("focus"));
  expect(reads("claude")).toBe(before.claude + 1);
  expect(reads("codex")).toBe(before.codex);
});

it("keeps unknown amounts unknown and marks retained quota values out of date after a refresh fails", async () => {
  const now = Date.now();
  let fail = false;
  mocks.call.mockImplementation(async (method, input) => {
    if (method === "memory.settings.get") return {};
    if (fail && input.provider === "codex") throw new Error("Offline");
    return {
      ...report,
      provider: input.provider,
      resets: undefined,
      windows:
        input.provider === "codex"
          ? [
              { id: "session", label: "Session", usedPercent: 18, remainingPercent: 82, resetsAt: now + 3600000, observedAt: now, exhausted: false },
              { id: "weekly", label: "Weekly", usedPercent: null, remainingPercent: null, resetsAt: null, observedAt: now, exhausted: false },
            ]
          : [],
    };
  });
  mount(<ProviderUsageOverview active />);
  const codex = screen.getByRole("region", { name: "Codex usage" });
  const meter = await within(codex).findByRole("progressbar", { name: "Session: reported allowance remaining" });
  expect(meter.getAttribute("aria-valuenow")).toBe("82");
  expect(within(codex).getAllByRole("progressbar")).toHaveLength(1);
  expect(within(codex).getByText("Not reported")).toBeTruthy();
  fail = true;
  fireEvent.click(within(codex).getByRole("button", { name: "Refresh Codex usage" }));
  await within(codex).findByRole("alert");
  expect(meter.getAttribute("aria-valuenow")).toBe("82");
  expect(meter.getAttribute("aria-valuetext")).toBe("82% remaining, out of date");
});
