// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { linkWords, lostWords } from "./link-words";
import type { LinkState } from "./manager";
import { QUIET_CONNECT_MS, useLinkWords } from "./use-link-words";

const mac = { id: "studio", name: "Studio" };
const over = (kind: "lan" | "tailnet"): LinkState => ({ kind: "connected", mac, route: { kind, host: "studio.local", port: 1 }, serial: 1 });

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it("names how the phone reaches the Mac, and what is in the way when it does not", () => {
  expect(linkWords(over("lan"))).toMatchObject({ tone: "ok", status: "Wi-Fi", spoken: "Connected over Wi-Fi" });
  expect(linkWords(over("tailnet"))).toMatchObject({ tone: "ok", status: "Tailscale" });
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
