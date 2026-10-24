// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import { leaveOnMacChange } from "../navigation";
import { MacsSheet } from "./MacsSheet";

/**
 * A stack as expo-router keeps it: Home with the Macs sheet over it. Like React Navigation's stack, back with nothing to
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
const phone = vi.hoisted(() => ({ state: null as LinkState | null, listeners: new Set<() => void>() }));
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
    forget: vi.fn(),
  };
  return { link, useLinkState: () => phone.state, useSavedMacs: () => [studio, laptop] };
});

beforeEach(async () => {
  const { link } = await import("../client");
  nav.stack = ["/", "/macs"];
  nav.unhandled = [];
  phone.listeners.clear();
  phone.state = { kind: "connected", mac: studio, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };
  // As the root layout does.
  const { router } = await import("expo-router");
  leaveOnMacChange(link, () => router.dismissTo("/"));
});
afterEach(cleanup);

it("goes Home once when another Mac is picked, with nothing left to close", () => {
  render(<MacsSheet />);
  act(() => screen.getByRole("button", { name: "Laptop" }).click());
  expect(nav.stack).toEqual(["/"]);
  expect(nav.unhandled).toEqual([]);
});

it("closes the sheet when the Mac already shown is picked", () => {
  render(<MacsSheet />);
  act(() => screen.getByRole("button", { name: "Studio, Connected" }).click());
  expect(nav.stack).toEqual(["/"]);
  expect(nav.unhandled).toEqual([]);
});
