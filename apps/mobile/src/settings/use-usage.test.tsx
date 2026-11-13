// @vitest-environment jsdom
import type { PlanLimits } from "@openorc/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { usageSource, useUsage } from "./use-usage";

const mac = vi.hoisted(() => ({
  shown: null as FakeMac | null,
  partner: null as FakeMac | null,
  state: { kind: "connecting", mac: { id: "studio", name: "Studio" }, why: null } as LinkState,
  partnerState: { kind: "waiting", mac: { id: "cloud", name: "Cloud" }, why: "silent", retryAt: null } as LinkState,
  group: { primary: "studio", partner: null as string | null },
  saved: [] as { id: string; kind: "mac" | "brain" }[],
  limits: vi.fn<() => Promise<PlanLimits[]>>(),
  partnerLimits: vi.fn<() => Promise<PlanLimits[]>>(),
}));

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  const reads = (limits: () => Promise<PlanLimits[]>) => (method: string) => (method === "providers.limits" ? limits() : Promise.reject(new Error(`no ${method}`)));
  mac.shown = fakeMac(reads(() => mac.limits()));
  mac.partner = fakeMac(reads(() => mac.partnerLimits()));
  const shownLink = { ...mac.shown.module.link, getState: () => mac.state };
  const partnerLink = { ...mac.partner.module.link, getState: () => mac.partnerState };
  return {
    ...mac.shown.module,
    hostLink: (host: string | null) => (host === null ? shownLink : partnerLink),
    hostClient: (host: string | null) => (host === null ? mac.shown!.module.client : mac.partner!.module.client),
    useHostGroup: () => mac.group,
    useSavedMacs: () => mac.saved,
  };
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
  mac.shown!.module.queryClient.clear();
  mac.partner!.module.queryClient.clear();
  mac.limits.mockReset();
  mac.partnerLimits.mockReset();
  mac.state = connected;
  mac.partnerState = { kind: "waiting", mac: { id: "cloud", name: "Cloud" }, why: "silent", retryAt: null };
  mac.group = { primary: "studio", partner: null };
  mac.saved = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const open = () => renderHook(() => useUsage(), { wrapper: mac.shown!.wrapper });

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

const shownCloud = { id: "cloud", name: "Cloud", kind: "brain" as const };
const answering = (id: string, name: string): LinkState => ({ kind: "connected", mac: { id, name }, route: { kind: "public", host: `${id}.example`, port: 443 }, serial: 1 });

it("shows the Mac's limits while the cloud brain Home shows cannot be reached, and asks nothing of the brain", async () => {
  mac.state = { kind: "waiting", mac: shownCloud, why: "silent", retryAt: null };
  mac.partnerState = answering("studio", "Studio");
  mac.group = { primary: "cloud", partner: "studio" };
  mac.saved = [{ id: "cloud", kind: "brain" }];
  mac.partnerLimits.mockResolvedValue([codex(now - 1_000)]);
  const usage = open();
  await waitFor(() => expect(usage.result.current.state).toBe("ready"));
  expect(usage.result.current).toMatchObject({ live: true, hostName: "Studio", accounts: [codex(now - 1_000)] });
  expect(mac.limits).not.toHaveBeenCalled();
});

it("prefers the Mac over its brain while both answer, the brain while the Mac is away, and keeps each host's read apart", async () => {
  mac.partnerState = answering("cloud", "Cloud");
  mac.group = { primary: "studio", partner: "cloud" };
  mac.saved = [{ id: "studio", kind: "mac" }];
  mac.limits.mockResolvedValue([codex(now - 5_000)]);
  mac.partnerLimits.mockResolvedValue([codex(now - 1_000)]);
  const usage = open();
  await waitFor(() => expect(mac.partnerLimits).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(usage.result.current.accounts).toEqual([codex(now - 5_000)]));
  mac.state = waiting;
  usage.rerender();
  expect(usage.result.current).toMatchObject({ live: true, accounts: [codex(now - 1_000)], hostName: "Cloud" });
});

it("orders the Mac first though the brain is shown", async () => {
  mac.state = answering("cloud", "Cloud");
  mac.partnerState = answering("studio", "Studio");
  mac.group = { primary: "cloud", partner: "studio" };
  mac.saved = [{ id: "cloud", kind: "brain" }];
  mac.limits.mockResolvedValue([codex(now - 1_000)]);
  mac.partnerLimits.mockResolvedValue([codex(now - 5_000)]);
  const usage = open();
  await waitFor(() => expect(mac.partnerLimits).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(usage.result.current).toMatchObject({ hostName: "Studio", accounts: [codex(now - 5_000)] }));
});

it("asks again when told, after a read that failed", async () => {
  mac.limits.mockRejectedValue(new Error("Your Mac did not answer in time."));
  const usage = open();
  await waitFor(() => expect(usage.result.current.state).toBe("failed"), { timeout: 5_000 });
  mac.limits.mockResolvedValue([codex(now)]);
  act(() => usage.result.current.retry());
  await waitFor(() => expect(usage.result.current.state).toBe("ready"));
});

it("waits with the name of the host it would read first", () => {
  mac.state = waiting;
  expect(open().result.current).toMatchObject({ state: "loading", live: false, hostName: "Studio" });
});

const host = (live: boolean, readAt: number | null, windows: boolean) => ({ live, readAt, accounts: windows ? [codex(readAt ?? now)] : [] });

it("chooses a host that answers with limits, else the newest last read, else whichever answers", () => {
  const macRead = host(true, 1, true);
  const brainRead = host(true, 2, true);
  expect(usageSource([macRead, brainRead])).toBe(macRead);
  const away = host(false, 9, true);
  expect(usageSource([away, brainRead])).toBe(brainRead);
  const older = host(false, 1, true);
  const newer = host(false, 2, true);
  expect(usageSource([older, newer])).toBe(newer);
  const empty = host(true, null, false);
  expect(usageSource([empty, older])).toBe(older);
  const nothing = host(false, null, false);
  expect(usageSource([nothing, empty])).toBe(empty);
  expect(usageSource([nothing])).toBe(nothing);
});

it("prefers a connected host reporting only an fx balance over a host with no limits", async () => {
  mac.partnerState = answering("cloud", "Cloud");
  mac.group = { primary: "studio", partner: "cloud" };
  mac.saved = [{ id: "studio", kind: "mac" }];
  const fx: PlanLimits = {
    id: "fx",
    provider: "fx",
    name: "fx",
    plan: null,
    status: "available",
    refreshedAt: now,
    windows: [],
    credits: [{ label: "AI Gateway balance", balance: "12.50", unlimited: false, currency: "USD" }],
  };
  mac.limits.mockResolvedValue([]);
  mac.partnerLimits.mockResolvedValue([fx]);
  const usage = open();
  await waitFor(() => expect(usage.result.current.accounts).toEqual([fx]));
  expect(usage.result.current.live).toBe(true);
});
