// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { SharedValue } from "react-native-reanimated";
import { afterEach, expect, it, vi } from "vitest";
import type { LinkState } from "../../connection/manager";
import { HomeBar } from "./HomeBar";
import { LostLine } from "./MacLine";

vi.mock("expo-router", () => ({ Link: ({ children }: { children: ReactNode }) => <>{children}</> }));
const demo = vi.hoisted(() => ({ ended: 0, saved: [] as { id: string; kind?: "brain" }[] }));
vi.mock("../../client", async () => {
  const { ScratchStore } = await import("../../scratch-store");
  return {
    storage: new ScratchStore({ getString: () => undefined, set: () => undefined, remove: () => undefined }),
    endDemo: () => void demo.ended++,
    useSavedMacs: () => demo.saved,
  };
});
vi.mock("../../generated/icons", async (original) => ({
  ...(await original<object>()),
  Laptop: () => <span data-testid="laptop" />,
  Cloud: () => <span data-testid="cloud" />,
}));

afterEach(cleanup);

const studio = { id: "studio", name: "Studio" };
const connected: LinkState = { kind: "connected", mac: studio, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };
const tailnet: LinkState = { kind: "waiting", mac: studio, why: "tailnet", retryAt: null };
const quickConnect: LinkState = { kind: "connecting", mac: studio, why: null };

/** The list scrolled `y` points. */
const shared = <T,>(value: T) => ({ value }) as SharedValue<T>;
const bar = (state: LinkState, tab?: "threads" | "orclings" | "tasks") => render(<HomeBar state={state} scroll={{ scrollY: shared(0) }} tab={tab} />);
/** The bar's buttons by the names VoiceOver reads, left to right. */
const circles = () => screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);

it("puts the connection first among the circles, a laptop for a Mac and a cloud for a cloud brain", () => {
  demo.saved = [{ id: "studio" }];
  bar(connected);
  expect(screen.getByRole("header", { name: "OpenOrc" })).toBeTruthy();
  expect(circles()).toEqual(["Studio, Connected over Wi-Fi", "Show", "Settings"]);
  expect(screen.getByTestId("laptop")).toBeTruthy();
  expect(screen.queryByTestId("link-dot")).toBeNull();
  cleanup();
  demo.saved = [{ id: "cloud", kind: "brain" }];
  const cloud: LinkState = { kind: "connected", mac: { id: "cloud", name: "Cloud" }, route: { kind: "public", host: "cloud.example", port: 1 }, serial: 1 };
  bar(cloud);
  expect(screen.getByRole("button", { name: "Cloud, Connected over Internet" })).toBeTruthy();
  expect(screen.getByTestId("cloud")).toBeTruthy();
});

it("rings the connection and says what is wrong after the wordmark while the phone is not connected", () => {
  demo.saved = [{ id: "studio" }];
  bar(tailnet);
  expect(screen.getAllByRole("button", { name: "Studio, Not reachable over Tailscale" })).toHaveLength(2);
  expect(screen.getByText("Check Tailscale")).toBeTruthy();
  expect(screen.getAllByTestId("link-dot")).toHaveLength(2);
});

it("adds nothing after the wordmark while connected, or while a quick connect holds its words back", () => {
  bar(connected);
  expect(screen.queryByText("Wi-Fi")).toBeNull();
  expect(screen.getAllByRole("button", { name: /^Studio/ })).toHaveLength(1);
  cleanup();
  bar(quickConnect);
  expect(screen.getAllByRole("button", { name: /^Studio/ })).toHaveLength(1);
});

it("says why a Mac went, with no dot, when the person did not forget it", () => {
  render(<LostLine lost={{ why: "removed", macName: "Studio" }} />);
  expect(screen.getByText("Studio removed this iPhone")).toBeTruthy();
  expect(screen.queryByTestId("link-dot")).toBeNull();
  cleanup();
  render(<LostLine lost={{ why: "key-lost", macName: "Studio" }} />);
  expect(screen.getByText("This iPhone lost its key for Studio")).toBeTruthy();
  expect(screen.queryByTestId("link-dot")).toBeNull();
});

it("offers only Settings in the bar with no Mac, with no connection, status or hairline, as nothing scrolls", () => {
  render(<HomeBar state={{ kind: "unpaired", lost: { why: "removed", macName: "Studio" } }} />);
  expect(circles()).toEqual(["Settings"]);
  expect(screen.queryByTestId("link-dot")).toBeNull();
  expect(screen.queryByTestId("scroll-edge")).toBeNull();
});

const demoMac: LinkState = { kind: "connected", mac: { id: "demo", name: "Demo Mac" }, route: { kind: "demo" }, serial: 1 };

it("puts Skip where Settings sits while the demo shows, and Skip leaves the demo", () => {
  demo.ended = 0;
  demo.saved = [];
  bar(demoMac);
  expect(circles()).toEqual(["Demo Mac, On this iPhone", "Show", "Skip"]);
  screen.getByRole("button", { name: "Skip" }).click();
  expect(demo.ended).toBe(1);
});

it("keeps the filter for Threads alone; over the Orclings and Tasks tabs the connection and Settings stay", () => {
  demo.saved = [{ id: "studio" }];
  for (const tab of ["orclings", "tasks"] as const) {
    cleanup();
    bar(connected, tab);
    expect(circles()).toEqual(["Studio, Connected over Wi-Fi", "Settings"]);
  }
});
