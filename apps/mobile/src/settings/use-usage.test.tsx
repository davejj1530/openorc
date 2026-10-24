// @vitest-environment jsdom
import type { PlanLimits } from "@openorc/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { useUsage } from "./use-usage";

const mac = vi.hoisted(() => ({
  phone: null as FakeMac | null,
  state: { kind: "connecting", mac: { id: "studio", name: "Studio" }, why: null } as LinkState,
  limits: vi.fn<() => Promise<PlanLimits[]>>(),
}));

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method) => (method === "providers.limits" ? mac.limits() : Promise.reject(new Error(`no ${method}`))));
  return { ...mac.phone.module, useLinkState: () => mac.state };
});

const studio = { id: "studio", name: "Studio" };
const connected: LinkState = { kind: "connected", mac: studio, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };
const waiting: LinkState = { kind: "waiting", mac: studio, why: "silent", retryAt: null };
const now = Date.UTC(2026, 9, 24, 17, 30);
const codex = (refreshedAt: number): PlanLimits => ({
  id: "codex",
  provider: "codex",
  name: "Codex",
  plan: "Pro",
  status: "available",
  windows: [{ id: "codex:primary", label: "5-hour window", usedPercent: 12, remainingPercent: 88, resetsAt: now + 3_600_000, observedAt: refreshedAt, exhausted: false }],
  refreshedAt,
});
const claude: PlanLimits = { id: "claude:claude-cli", provider: "claude", name: "Claude", plan: "Max", status: "error", windows: [], refreshedAt: null };

beforeEach(() => {
  vi.useFakeTimers({ now, shouldAdvanceTime: true });
  mac.phone!.module.queryClient.clear();
  mac.limits.mockReset();
  mac.state = connected;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const open = () => renderHook(() => useUsage(), { wrapper: mac.phone!.wrapper });

it("reads the Mac's limits while connected, live, and counts down on a 30 s beat", async () => {
  mac.limits.mockResolvedValue([codex(now - 60_000), claude]);
  const usage = open();
  expect(usage.result.current).toMatchObject({ state: "loading", accounts: [], live: true, readAt: null });
  await waitFor(() => expect(usage.result.current.state).toBe("ready"));
  expect(usage.result.current).toMatchObject({ accounts: [codex(now - 60_000), claude], live: true, readAt: now - 60_000 });
  const before = usage.result.current.now;
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(usage.result.current.now - before).toBeGreaterThanOrEqual(30_000);
  expect(mac.limits).toHaveBeenCalledTimes(1);
});

it("keeps the last read with its time while the phone is not connected, with the countdowns held, and asks nothing", async () => {
  mac.limits.mockResolvedValue([codex(now - 60_000)]);
  const usage = open();
  await waitFor(() => expect(usage.result.current.state).toBe("ready"));
  mac.state = waiting;
  usage.rerender();
  const held = usage.result.current.now;
  await act(() => vi.advanceTimersByTimeAsync(120_000));
  usage.rerender();
  expect(usage.result.current).toMatchObject({ state: "ready", live: false, accounts: [codex(now - 60_000)], readAt: now - 60_000, now: held });
  expect(mac.limits).toHaveBeenCalledTimes(1);
  mac.state = connected;
  usage.rerender();
  await waitFor(() => expect(mac.limits).toHaveBeenCalledTimes(2));
  expect(usage.result.current.live).toBe(true);
  expect(usage.result.current.now).toBeGreaterThan(held);
});

it("shows the last read when Settings opens again long after, while not connected", async () => {
  mac.limits.mockResolvedValue([codex(now - 60_000)]);
  const first = open();
  await waitFor(() => expect(first.result.current.state).toBe("ready"));
  first.unmount();
  mac.state = waiting;
  await act(() => vi.advanceTimersByTimeAsync(30 * 60_000));
  expect(open().result.current).toMatchObject({ state: "ready", live: false, accounts: [codex(now - 60_000)], readAt: now - 60_000 });
});

it("waits for a connection before the first read, and fails only with nothing to show", async () => {
  mac.state = waiting;
  const usage = open();
  expect(usage.result.current).toMatchObject({ state: "loading", live: false });
  expect(mac.limits).not.toHaveBeenCalled();
  mac.limits.mockRejectedValue(new Error("Your Mac did not answer in time."));
  mac.state = connected;
  usage.rerender();
  await waitFor(() => expect(usage.result.current.state).toBe("failed"), { timeout: 5_000 });
  expect(usage.result.current.accounts).toEqual([]);
});
