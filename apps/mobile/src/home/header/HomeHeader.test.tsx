// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { SharedValue } from "react-native-reanimated";
import { afterEach, expect, it, vi } from "vitest";
import type { DownReason, LinkState } from "../../connection/manager";
import { nativeProps } from "../../test-fixtures/react-native";
import { HomeBar } from "./HomeBar";
import { LostLine } from "./MacLine";

vi.mock("expo-router", () => ({ Link: ({ children }: { children: ReactNode }) => <>{children}</> }));
const demo = vi.hoisted(() => ({ ended: 0 }));
vi.mock("../../client", async () => {
  const { ScratchStore } = await import("../../scratch-store");
  return {
    storage: new ScratchStore({ getString: () => undefined, set: () => undefined, remove: () => undefined }),
    shownMacId: () => "studio",
    endDemo: () => void demo.ended++,
  };
});
/** What the Mac says of its OpenOrc account: nothing, until a test signs someone in. */
const account = vi.hoisted(() => ({ spaces: { state: "none" } as import("../../spaces/use-spaces").PhoneSpaces }));
vi.mock("../../spaces/use-spaces", async (original) => ({ ...(await original<object>()), useSpaces: () => account.spaces }));
vi.mock("../../generated/icons", async (original) => ({
  ...(await original<object>()),
  Laptop: () => <span data-testid="laptop" />,
  Funnel: ({ className }: { className?: string }) => <span data-testid="filter-mark" className={className} />,
  Pin: ({ className }: { className?: string }) => <span data-testid="filter-mark" data-pin className={className} />,
}));

afterEach(() => {
  cleanup();
  account.spaces = { state: "none" };
});

const studio = { id: "studio", name: "Studio" };
const connected: LinkState = { kind: "connected", mac: studio, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };
const tailnet: LinkState = { kind: "waiting", mac: studio, why: "tailnet", retryAt: null };
const quickConnect: LinkState = { kind: "connecting", mac: studio, why: null };

/** The list scrolled `y` points. */
const shared = <T,>(value: T) => ({ value }) as SharedValue<T>;
const bar = (state: LinkState, tab?: "threads" | "orclings" | "tasks") => render(<HomeBar state={state} scroll={{ scrollY: shared(0) }} tab={tab} />);
/** The room after the title and the status's own width, as the phone lays them out. */
function layOut(room: number, status: number) {
  const width = (id: string, value: number) => nativeProps.get(screen.getByTestId(id))?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: value, height: 52 } } });
  act(() => {
    width("status-room", room);
    width("link-status", status);
  });
}

/** The bar's buttons by the names VoiceOver reads, left to right. */
const circles = () => screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);

it("puts the connection first among the circles, as a laptop", () => {
  bar(connected);
  expect(screen.getByRole("header", { name: "OpenOrc" })).toBeTruthy();
  expect(circles()).toEqual(["Studio, Connected over Wi-Fi", "Show", "Settings"]);
  expect(screen.getByTestId("laptop")).toBeTruthy();
  expect(screen.queryByTestId("link-dot")).toBeNull();
});

it("rings the connection and says what is wrong after the wordmark while the phone is not connected", () => {
  bar(tailnet);
  layOut(200, 120);
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

it("edges the bar with the hairline the app's other bars use once the list scrolls under it", () => {
  bar(connected);
  expect(screen.getByTestId("scroll-edge")).toBeTruthy();
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
  bar(demoMac);
  expect(circles()).toEqual(["Demo Mac, On this iPhone", "Show", "Skip"]);
  screen.getByRole("button", { name: "Skip" }).click();
  expect(demo.ended).toBe(1);
});

it("keeps the filter for Threads alone; over the Orclings and Tasks tabs the connection and Settings stay", () => {
  for (const tab of ["orclings", "tasks"] as const) {
    cleanup();
    bar(connected, tab);
    expect(circles()).toEqual(["Studio, Connected over Wi-Fi", "Settings"]);
  }
});

it("titles Home with the space it shows once the Mac's person is signed in to OpenOrc, and with the wordmark until then", () => {
  const birch = { id: "org-birch", kind: "organization", name: "Birch Studio", logo: null, memberId: "member", role: "member", memberCount: 2 } as const;
  const { unmount } = render(<HomeBar state={connected} />);
  expect(screen.getByText("OpenOrc")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /space$/ })).toBeNull();
  unmount();
  account.spaces = { state: "ready", spaces: [{ id: "personal-me", kind: "personal" }, birch], current: birch, access: null, offline: false };
  render(<HomeBar state={connected} />);
  expect(screen.getByRole("button", { name: "Birch Studio, space" })).toBeTruthy();
  expect(screen.getByText("Birch Studio")).toBeTruthy();
  expect(screen.queryByText("OpenOrc")).toBeNull();
  cleanup();
  account.spaces = { state: "signed-out" };
  render(<HomeBar state={connected} />);
  expect(screen.getByText("OpenOrc")).toBeTruthy();
});

it("titles Personal as OpenOrc, as the Mac's sidebar heads it, still opening the spaces", () => {
  const personal = { id: "personal-me", kind: "personal" } as const;
  account.spaces = { state: "ready", spaces: [personal], current: personal, access: null, offline: false };
  render(<HomeBar state={connected} />);
  expect(screen.getByRole("button", { name: "OpenOrc, Personal space" })).toBeTruthy();
  expect(screen.getByText("OpenOrc")).toBeTruthy();
  expect(screen.queryByText("Personal")).toBeNull();
});

it("marks the filter in the accent while a filter narrows the list, and names what does", async () => {
  const { chooseFilter, chooseOwnership } = await import("../filter");
  const birch = { id: "org-birch", kind: "organization", name: "Birch Studio", logo: null, memberId: "member", role: "member", memberCount: 2 } as const;
  account.spaces = { state: "ready", spaces: [{ id: "personal-me", kind: "personal" }, birch], current: birch, access: null, offline: false };
  const view = render(<HomeBar state={connected} />);
  const mark = () => screen.getByTestId("filter-mark");
  expect(screen.getByRole("button", { name: "Show" })).toBeTruthy();
  expect(mark().className).toBe("text-ink-3");
  act(() => chooseOwnership("org-birch", "mine"));
  expect(screen.getByRole("button", { name: "Show, Mine" })).toBeTruthy();
  expect(mark().className).toBe("text-accent-ink");
  act(() => chooseFilter("pinned"));
  expect(screen.getByRole("button", { name: "Show, Pinned threads, Mine" })).toBeTruthy();
  expect(mark().hasAttribute("data-pin")).toBe(true);
  act(() => {
    chooseFilter("all");
    chooseOwnership("org-birch", "everyone");
  });
  view.unmount();
});

it("offers no filter where Home has no list, as for a space shut to the person", () => {
  render(<HomeBar state={connected} listed={false} />);
  expect(screen.queryByRole("button", { name: /^Show/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
});

it("lets the status leave whole before a long organization's name loses a letter, at its own type size, in every link state", () => {
  const long = { id: "org-long", kind: "organization", name: "Northern Lights Cooperative Engineering", logo: null, memberId: "member", role: "member", memberCount: 9 } as const;
  account.spaces = { state: "ready", spaces: [{ id: "personal-me", kind: "personal" }, long], current: long, access: null, offline: false };
  const reasons: DownReason[] = ["unreachable", "silent", "tailnet", "no-route", "offline", "restarting", "disabled", "busy"];
  const states: LinkState[] = [
    { kind: "connecting", mac: studio, why: "unreachable" },
    ...reasons.map((why): LinkState => ({ kind: "waiting", mac: studio, why, retryAt: null })),
    { kind: "incompatible", mac: studio },
  ];
  for (const state of states) {
    bar(state);
    const status = screen.getByTestId("link-status");
    // Measured, it stands only where its words fit whole after the name; otherwise it leaves, VoiceOver and touch with it.
    layOut(40, 120);
    expect(status.getAttribute("aria-hidden")).toBe("true");
    expect(nativeProps.get(status)?.className).toContain("opacity-0");
    expect(screen.getByText(long.name)).toBeTruthy();
    layOut(200, 120);
    expect(status.getAttribute("aria-hidden")).toBeNull();
    expect(nativeProps.get(status)?.className).not.toContain("opacity-0");
    // Its words keep their size: nothing fits them to the room.
    const words = Array.from(status.querySelectorAll("span")).find((node) => node.textContent && node.textContent.length > 1)!;
    expect(nativeProps.get(words)?.adjustsFontSizeToFit).toBeUndefined();
    cleanup();
  }
});
