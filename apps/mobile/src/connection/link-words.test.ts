// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { Route } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { linkWords, lostWords } from "./link-words";
import type { LinkState } from "./manager";
import { QUIET_CONNECT_MS, useLinkWords } from "./use-link-words";

const mac = { id: "studio", name: "Studio" };
const over = (kind: Route["kind"]): LinkState => ({ kind: "connected", mac, route: { kind, host: "studio.local", port: 1 }, serial: 1 });

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it("names how the phone reaches the Mac, and what is in the way when it does not", () => {
  expect(linkWords(over("lan"))).toMatchObject({ tone: "ok", status: "Wi-Fi", spoken: "Connected over Wi-Fi" });
  expect(linkWords(over("tailnet"))).toMatchObject({ tone: "ok", status: "Tailscale" });
  expect(linkWords(over("public"))).toMatchObject({ tone: "ok", status: "Internet" });
  expect(linkWords({ kind: "waiting", mac, why: "tailnet", retryAt: null })).toMatchObject({ tone: "attention", status: "Check Tailscale" });
  // With nothing getting out, no advice: Tailscale is not to blame, and neither is the Mac.
  expect(linkWords({ kind: "waiting", mac, why: "offline", retryAt: 1 })).toEqual({ tone: "off", status: "No internet", spoken: "No internet", detail: "No internet" });
  expect(linkWords({ kind: "waiting", mac, why: "tailnet", retryAt: null }).detail).toBe("Tailscale is off on this iPhone, or another VPN is on.");
  expect(linkWords({ kind: "connecting", mac, why: "unreachable" })).toMatchObject({ tone: "busy", status: "Reconnecting" });
  expect(linkWords({ kind: "waiting", mac, why: "silent", retryAt: 1 })).toEqual({
    tone: "off",
    status: "Not reachable",
    spoken: "Not reachable",
    detail: "This Mac isn’t answering. It may be asleep or on another network.",
  });
  expect(lostWords.removed("Studio")).toBe("Studio removed this iPhone");
});

it("says what a host's door is doing, at once, while it wakes the host or could not", () => {
  expect(linkWords({ kind: "connecting", mac, why: "waking" })).toMatchObject({ tone: "busy", status: "Waking" });
  expect(linkWords({ kind: "waiting", mac, why: "wake-refused", retryAt: 1 })).toMatchObject({ tone: "attention", status: "Can’t wake it" });
  expect(linkWords({ kind: "waiting", mac, why: "needs-mac", retryAt: 1 })).toMatchObject({ tone: "attention", status: "Needs your Mac" });
  expect(linkWords({ kind: "waiting", mac, why: "wake-failed", retryAt: 1 })).toMatchObject({ tone: "attention", status: "Didn’t start" });
  const words = renderHook(() => useLinkWords({ kind: "connecting", mac, why: "waking" }));
  expect(words.result.current.status).toBe("Waking");
});

it("never calls a cloud brain a Mac, and says where to look instead", () => {
  const brain = { id: "cloud", name: "Cloud", kind: "brain" as const };
  for (const why of ["unreachable", "silent"] as const)
    expect(linkWords({ kind: "waiting", mac: brain, why, retryAt: 1 }).detail).toBe("This cloud brain isn’t answering. Check it in OpenOrc’s Cloud settings on your Mac.");
  for (const why of ["restarting", "disabled", "busy", "no-route", "tailnet", "offline", "waking", "wake-refused", "needs-mac", "wake-failed"] as const)
    expect(linkWords({ kind: "waiting", mac: brain, why, retryAt: 1 }).detail).not.toMatch(/this Mac/);
  expect(linkWords({ kind: "incompatible", mac: brain } as LinkState).detail).toBe("Update OpenOrc on this iPhone and on your Mac.");
  expect(linkWords({ kind: "waiting", mac, why: "silent", retryAt: 1 }).detail).toBe("This Mac isn’t answering. It may be asleep or on another network.");
});

it("says the demo Mac lives on this iPhone, with no route to name", () => {
  const demo: LinkState = { kind: "connected", mac: { id: "demo", name: "Demo Mac" }, route: { kind: "demo" }, serial: 1 };
  expect(linkWords(demo)).toEqual({ tone: "ok", status: null, spoken: "On this iPhone", detail: "On this iPhone" });
});

it("holds a quick connect's words back, so only the dot changes", () => {
  const words = renderHook(({ state }) => useLinkWords(state), { initialProps: { state: { kind: "connecting", mac, why: null } as LinkState } });
  expect(words.result.current).toMatchObject({ tone: "busy", status: null });
  act(() => void vi.advanceTimersByTime(QUIET_CONNECT_MS));
  expect(words.result.current.status).toBe("Connecting");
  words.rerender({ state: over("lan") });
  expect(words.result.current.status).toBe("Wi-Fi");
});
