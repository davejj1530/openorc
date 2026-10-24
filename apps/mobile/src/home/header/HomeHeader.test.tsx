// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { SharedValue } from "react-native-reanimated";
import { afterEach, expect, it, vi } from "vitest";
import type { LinkState } from "../../connection/manager";
import { flatStyle, nativeProps } from "../../test-fixtures/react-native";
import { HomeBar } from "./HomeBar";
import { LostLine, MacLine } from "./MacLine";

vi.mock("expo-router", () => ({ Link: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("../../client", () => ({ storage: { getString: () => undefined, set: () => undefined, remove: () => undefined } }));

afterEach(cleanup);

const studio = { id: "studio", name: "Studio" };
const connected: LinkState = { kind: "connected", mac: studio, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };
const tailnet: LinkState = { kind: "waiting", mac: studio, why: "tailnet", retryAt: null };
const quickConnect: LinkState = { kind: "connecting", mac: studio, why: null };

/** The list scrolled `y` points, with the Mac line ending 16 points into it. */
const shared = <T,>(value: T) => ({ value }) as SharedValue<T>;
const scrolled = (y: number) => ({ scrollY: shared(y), lineBottom: shared(16) });
const bar = (state: LinkState, y: number) => render(<HomeBar state={state} scroll={scrolled(y)} />);

/** The pinned row's word on the link, as VoiceOver finds it, with how much of it shows. */
function pinnedStatus(name: string) {
  const found = screen.queryByRole("button", { name });
  if (!found) return null;
  let shown = 1;
  for (let node: Element | null = found; node; node = node.parentElement) shown *= (flatStyle(nativeProps.get(node)?.style).opacity as number | undefined) ?? 1;
  return shown;
}

it("keeps the pinned row to the wordmark and its buttons while the Mac line is in view", () => {
  bar(tailnet, 0);
  expect(screen.getByRole("header", { name: "OpenOrc" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
  expect(pinnedStatus("Studio, Not reachable over Tailscale")).toBeNull();
  expect(screen.queryByText("Check Tailscale")?.closest("[aria-hidden]")).toBeTruthy();
});

it("says what is wrong after the wordmark once the Mac line has scrolled under the bar", () => {
  bar(tailnet, 40);
  expect(pinnedStatus("Studio, Not reachable over Tailscale")).toBe(1);
  expect(screen.getByText("Check Tailscale")).toBeTruthy();
});

it("adds nothing to the pinned row while connected, or while a quick connect holds its words back", () => {
  bar(connected, 40);
  expect(screen.queryByRole("button", { name: /^Studio/ })).toBeNull();
  expect(screen.queryByText("Wi-Fi")).toBeNull();
  cleanup();
  bar(quickConnect, 40);
  expect(screen.queryByRole("button", { name: /^Studio/ })).toBeNull();
});

it("draws the link's dot beside a paired Mac, and none for a Mac that removed this iPhone or a lost key", () => {
  render(<MacLine state={tailnet} {...scrolled(0)} />);
  expect(screen.getByRole("button", { name: "Studio, Not reachable over Tailscale" })).toBeTruthy();
  expect(screen.getAllByTestId("link-dot")).toHaveLength(1);
  cleanup();
  render(<LostLine lost={{ why: "removed", macName: "Studio" }} />);
  expect(screen.getByText("Studio removed this iPhone")).toBeTruthy();
  expect(screen.queryByTestId("link-dot")).toBeNull();
  cleanup();
  render(<LostLine lost={{ why: "key-lost", macName: "Studio" }} />);
  expect(screen.getByText("This iPhone lost its key for Studio")).toBeTruthy();
  expect(screen.queryByTestId("link-dot")).toBeNull();
});

it("leaves the Mac line to VoiceOver only while the bar does not say the same", () => {
  render(<MacLine state={tailnet} {...scrolled(0)} />);
  expect(screen.getByRole("button", { name: "Studio, Not reachable over Tailscale" })).toBeTruthy();
  cleanup();
  // Past wherever the line lays out its words, here the whole window.
  render(<MacLine state={tailnet} {...scrolled(2_000)} />);
  expect(screen.queryByRole("button", { name: "Studio, Not reachable over Tailscale" })).toBeNull();
});

it("offers only Settings in the bar with no Mac, with no pinned status and no hairline, as nothing scrolls", () => {
  render(<HomeBar state={{ kind: "unpaired", lost: { why: "removed", macName: "Studio" } }} />);
  expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Show/ })).toBeNull();
  expect(screen.queryByTestId("link-dot")).toBeNull();
  expect(screen.queryByTestId("scroll-edge")).toBeNull();
});
