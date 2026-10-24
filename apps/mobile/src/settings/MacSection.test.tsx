// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import { leaveOnMacChange } from "../navigation";
import { felt } from "../test-fixtures/haptics";
import { alerts, nativeProps } from "../test-fixtures/react-native";
import { MacSection } from "./MacSection";

/**
 * A stack as expo-router keeps it: Home with Settings over it. Like React Navigation's stack, back with nothing to
 * close is not handled (a LogBox error in a dev build); a dismissTo where the route already shows is.
 */
const nav = vi.hoisted(() => ({ stack: [] as string[], unhandled: [] as string[] }));
vi.mock("expo-router", () => ({
  router: {
    back: () => (nav.stack.length > 1 ? void nav.stack.pop() : void nav.unhandled.push("GO_BACK")),
    dismissTo: (href: string) => {
      const index = nav.stack.lastIndexOf(href);
      if (index === -1) nav.unhandled.push(`POP_TO ${href}`);
      else nav.stack.length = index + 1;
    },
    push: (href: string) => void nav.stack.push(href),
  },
}));

const studio = { id: "studio", name: "Studio", routes: [], lastRoute: null };
const laptop = { id: "laptop", name: "Laptop", routes: [], lastRoute: null };
const phone = vi.hoisted(() => ({ state: null as LinkState | null, listeners: new Set<() => void>(), retried: 0, forgot: [] as string[] }));
vi.mock("../client", () => {
  const link = {
    getState: () => phone.state!,
    subscribe: (listener: () => void) => (phone.listeners.add(listener), () => void phone.listeners.delete(listener)),
    select: (id: string) => {
      const mac = [studio, laptop].find((saved) => saved.id === id)!;
      if (phone.state?.kind !== "unpaired" && phone.state?.mac.id === id) return;
      phone.state = { kind: "connecting", mac, why: null };
      phone.listeners.forEach((listener) => listener());
    },
    retry: () => (phone.retried++, Promise.resolve()),
    forget: (id: string) => void phone.forgot.push(id),
  };
  return { link, useLinkState: () => phone.state, useSavedMacs: () => [studio, laptop] };
});

const connected: LinkState = { kind: "connected", mac: studio, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };

beforeEach(async () => {
  const { link } = await import("../client");
  nav.stack = ["/", "/settings"];
  nav.unhandled = [];
  alerts.length = 0;
  felt.length = 0;
  phone.listeners.clear();
  phone.retried = 0;
  phone.forgot = [];
  phone.state = connected;
  // As the root layout does.
  const { router } = await import("expo-router");
  leaveOnMacChange(link, () => router.dismissTo("/"));
});
afterEach(cleanup);

it("goes Home once when another Mac is picked, with nothing left to close", () => {
  render(<MacSection state={phone.state!} />);
  act(() => screen.getByRole("button", { name: "Laptop" }).click());
  expect(nav.stack).toEqual(["/"]);
  expect(nav.unhandled).toEqual([]);
  expect(felt).toEqual(["selection"]);
});

it("goes Home when the shown Mac is picked, as the Macs sheet did", () => {
  render(<MacSection state={connected} />);
  const shown = screen.getByRole("button", { name: "Studio, Connected over Wi-Fi" });
  expect(nativeProps.get(shown)!.accessibilityState).toMatchObject({ selected: true });
  act(() => shown.click());
  expect(nav.stack).toEqual(["/"]);
  expect(felt).toEqual(["selection"]);
});

it("says how the shown Mac is reached, and offers to try again only while it is not connected", () => {
  const shown = render(<MacSection state={connected} />);
  expect(screen.getByRole("button", { name: "Studio, Connected over Wi-Fi" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  shown.rerender(<MacSection state={{ kind: "waiting", mac: studio, why: "tailnet", retryAt: null }} />);
  expect(screen.getByText("Tailscale is off on this iPhone, or another VPN is on.")).toBeTruthy();
  act(() => screen.getByRole("button", { name: "Try again" }).click());
  expect(phone.retried).toBe(1);
});

it("offers Forget on every Mac's row to VoiceOver, as its swipe does, and forgets only once confirmed", () => {
  render(<MacSection state={connected} />);
  for (const [row, name] of [
    ["Studio, Connected over Wi-Fi", "Studio"],
    ["Laptop", "Laptop"],
  ] as const) {
    const actions = nativeProps.get(screen.getByRole("button", { name: row }))!;
    expect(actions.accessibilityActions).toEqual([{ name: "Forget", label: "Forget" }]);
    act(() => (actions.onAccessibilityAction as (event: object) => void)({ nativeEvent: { actionName: "Forget" } }));
    expect(alerts.at(-1)).toMatchObject({ title: `Forget ${name}?`, message: "To connect again, scan a new code on your Mac." });
  }
  expect(phone.forgot).toEqual([]);
  act(() => alerts.at(-1)!.buttons!.find((button) => button.text === "Forget")!.onPress!());
  expect(phone.forgot).toEqual(["laptop"]);
});

it("pairs another Mac over Settings", () => {
  render(<MacSection state={connected} />);
  act(() => screen.getByRole("button", { name: "Pair another Mac" }).click());
  expect(nav.stack).toEqual(["/", "/settings", "/pair"]);
});
