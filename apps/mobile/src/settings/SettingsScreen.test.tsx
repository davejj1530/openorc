// @vitest-environment jsdom
import type { PlanLimits } from "@openorc/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import { felt } from "../test-fixtures/haptics";
import { alerts, nativeProps } from "../test-fixtures/react-native";
import { themes } from "../test-fixtures/uniwind";
import type { Usage } from "./use-usage";

const nav = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("expo-router", () => ({
  router: {
    back: () => void nav.calls.push("back"),
    dismissTo: (href: string) => void nav.calls.push(`dismissTo ${href}`),
    push: (href: string) => void nav.calls.push(`push ${href}`),
  },
  Stack: { Screen: () => null },
  Link: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const studio = { id: "studio", name: "Studio", routes: [], lastRoute: null };
const laptop = { id: "laptop", name: "Laptop", routes: [], lastRoute: null };
const phone = vi.hoisted(() => ({
  state: null as LinkState | null,
  macs: [] as unknown[],
  forgot: [] as string[],
  saved: new Map<string, string>(),
  alerts: { permission: "granted", prefs: { choice: "all", sound: true }, senders: new Map() },
}));
vi.mock("../client", async () => ({
  link: { select: () => undefined, retry: () => Promise.resolve() },
  alerts: {
    subscribe: () => () => undefined,
    getState: () => phone.alerts,
    forget: (id: string) => void phone.forgot.push(id),
  },
  useLinkState: () => phone.state,
  useSavedMacs: () => phone.macs,
  useHostGroup: () => ({ primary: "studio", partner: null }),
  usePartnerLinkState: () => phone.state,
  storage: new (await import("../scratch-store")).ScratchStore({
    getString: (key) => phone.saved.get(key),
    set: (key, value) => void phone.saved.set(key, value),
    remove: (key) => void phone.saved.delete(key),
  }),
  endDemo: () => void phone.forgot.push("end demo"),
}));

const usage = vi.hoisted(() => ({ now: 0, retried: 0, current: null as Usage | null }));
vi.mock("./use-usage", () => ({ useUsage: () => usage.current }));

const { SettingsScreen } = await import("./SettingsScreen");

const connected: LinkState = { kind: "connected", mac: studio, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };
const now = Date.UTC(2026, 9, 24, 18, 21);
const codex: PlanLimits = {
  id: "codex",
  provider: "codex",
  name: "Codex",
  plan: "Pro",
  status: "available",
  windows: [{ id: "codex:primary", label: "5-hour window", usedPercent: 12, remainingPercent: 88, resetsAt: now + 3_600_000, observedAt: now, exhausted: false }],
  refreshedAt: now,
};

beforeEach(() => {
  nav.calls = [];
  alerts.length = 0;
  felt.length = 0;
  phone.state = connected;
  phone.macs = [studio, laptop];
  phone.forgot = [];
  phone.saved.clear();
  usage.current = { accounts: [codex], state: "ready", live: true, readAt: now, now, hostName: "Studio", retry: () => void (usage.retried += 1) };
});
afterEach(cleanup);

const headings = () => screen.getAllByRole("header").map((heading) => heading.getAttribute("aria-label") ?? heading.textContent);
const buttons = () => screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);

it("shows the Mac, its usage and this iPhone in that order, and ends with forgetting the Mac", () => {
  render(<SettingsScreen />);
  const order = headings();
  expect(order[0]).toBe("Settings");
  expect(order.filter((heading) => ["Mac", "Usage", "This iPhone"].includes(heading!))).toEqual(["Mac", "Usage", "This iPhone"]);
  expect(screen.getByRole("button", { name: /^Notifications/ })).toBeTruthy();
  expect(buttons().at(-1)).toBe("Forget Studio");
  expect(screen.queryByText(/^OpenOrc /)).toBeNull();
});

it("offers pairing and this iPhone's appearance, with no notifications and nothing to forget, with no Mac", () => {
  phone.state = { kind: "unpaired", lost: null };
  phone.macs = [];
  render(<SettingsScreen />);
  expect(headings()).toEqual(["Settings", "Mac", "This iPhone"]);
  expect(screen.getByRole("button", { name: "Appearance, System" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Notifications/ })).toBeNull();
  act(() => screen.getByRole("button", { name: "Pair a Mac" }).click());
  expect(nav.calls).toEqual(["push /pair"]);
  expect(screen.queryByRole("button", { name: /^Forget/ })).toBeNull();
});

it("keeps notifications for a saved Mac it cannot reach", () => {
  phone.state = { kind: "waiting", mac: studio, why: "unreachable", retryAt: null };
  render(<SettingsScreen />);
  expect(screen.getByRole("button", { name: /^Notifications/ })).toBeTruthy();
});

it("shows the demo Mac with pairing, its usage and the appearance, without notifications, and ends the demo last", () => {
  phone.state = { kind: "connected", mac: { id: "demo", name: "Demo Mac" }, route: { kind: "demo" }, serial: 1 };
  phone.macs = [];
  render(<SettingsScreen />);
  expect(headings().filter((heading) => ["Mac", "Usage", "This iPhone"].includes(heading!))).toEqual(["Mac", "Usage", "This iPhone"]);
  expect(screen.getByText("Demo Mac")).toBeTruthy();
  expect(screen.getByText("On this iPhone")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Notifications/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Appearance, System" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Forget/ })).toBeNull();
  expect(buttons().at(-1)).toBe("End demo");
  act(() => screen.getByRole("button", { name: "End demo" }).click());
  expect(alerts).toEqual([]);
  expect(phone.forgot).toEqual(["end demo"]);
  act(() => screen.getByRole("button", { name: "Pair a Mac" }).click());
  expect(nav.calls).toEqual(["push /pair"]);
});

it("forgets the shown Mac only once the person confirms", () => {
  render(<SettingsScreen />);
  act(() => screen.getByRole("button", { name: "Forget Studio" }).click());
  expect(alerts).toMatchObject([{ title: "Forget Studio?", message: "To connect again, scan a new code on your Mac." }]);
  act(() => alerts[0]!.buttons!.find((button) => button.text === "Cancel")!.onPress?.());
  expect(phone.forgot).toEqual([]);
  act(() => alerts[0]!.buttons!.find((button) => button.text === "Forget")!.onPress!());
  expect(phone.forgot).toEqual(["studio"]);
});

it("closes with its close button or VoiceOver's escape", () => {
  const { container } = render(<SettingsScreen />);
  act(() => screen.getByRole("button", { name: "Close" }).click());
  const sheet = Array.from(container.querySelectorAll("*")).find((node) => nativeProps.get(node)?.onAccessibilityEscape);
  act(() => (nativeProps.get(sheet!)!.onAccessibilityEscape as () => void)());
  expect(nav.calls).toEqual(["back", "back"]);
});

it("picks the appearance from one row's menu, with a check on the current choice, and keeps it", () => {
  render(<SettingsScreen />);
  act(() => screen.getByRole("button", { name: "Appearance, System" }).click());
  const choices = () => screen.getAllByRole("menuitemradio").map((item) => [item.textContent, item.getAttribute("aria-checked")]);
  expect(choices()).toEqual([
    ["System", "true"],
    ["Light", "false"],
    ["Dark", "false"],
  ]);
  act(() => screen.getByRole("menuitemradio", { name: "Dark" }).click());
  expect(phone.saved.get("appearance")).toBe("dark");
  expect(themes.at(-1)).toBe("dark");
  expect(felt).toEqual(["selection"]);
  expect(screen.getByRole("button", { name: "Appearance, Dark" })).toBeTruthy();
  // The current choice again changes nothing.
  act(() => screen.getByRole("menuitemradio", { name: "Dark" }).click());
  expect(felt).toEqual(["selection"]);
});

it("dims the last read while not connected and says when it was read, above the cards", () => {
  usage.current = { accounts: [codex], state: "ready", live: false, readAt: now, now, hostName: "Studio", retry: () => undefined };
  render(<SettingsScreen />);
  const read = screen.getByText(`Last read at ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(now)}`);
  const label = screen.getByText("Usage");
  const codexCard = screen.getByRole("header", { name: "Codex, Pro" });
  expect(label.compareDocumentPosition(read) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(read.compareDocumentPosition(codexCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(dimmed(codexCard)).toBe(true);
});

it("shows the usage at full strength, with no read time, while connected", () => {
  render(<SettingsScreen />);
  expect(screen.queryByText(/^Last read at/)).toBeNull();
  expect(dimmed(screen.getByRole("header", { name: "Codex, Pro" }))).toBe(false);
});

it("shows Antigravity's model pools and reset times in the same usage cards", () => {
  const antigravity: PlanLimits = {
    id: "antigravity",
    provider: "antigravity",
    name: "Antigravity",
    plan: null,
    status: "available",
    refreshedAt: now,
    windows: [
      { ...codex.windows[0]!, id: "gemini-weekly", label: "Weekly Limit · Gemini Models", group: "Gemini Models", usedPercent: 3, remainingPercent: 97 },
      { ...codex.windows[0]!, id: "3p-weekly", label: "Weekly Limit · Claude and GPT models", group: "Claude and GPT models", usedPercent: 0, remainingPercent: 100 },
    ],
  };
  usage.current = { accounts: [antigravity], state: "ready", live: true, readAt: now, now, hostName: "Studio", retry: () => undefined };
  render(<SettingsScreen />);
  expect(screen.getByRole("header", { name: "Antigravity" })).toBeTruthy();
  expect(screen.getByLabelText(/Weekly Limit · Gemini Models, 97% left, Resets/)).toBeTruthy();
  expect(screen.getByLabelText(/Weekly Limit · Claude and GPT models, 100% left, Resets/)).toBeTruthy();
});

it("waits for the host by name, and offers another try after a read that failed, instead of a dead end", () => {
  usage.current = { accounts: [], state: "loading", live: false, readAt: null, now, hostName: "Eliass-MacBook-Pro", retry: () => undefined };
  const waiting = render(<SettingsScreen />);
  expect(screen.getByText("Waiting for Eliass-MacBook-Pro")).toBeTruthy();
  waiting.unmount();

  usage.retried = 0;
  usage.current = { accounts: [], state: "failed", live: true, readAt: null, now, hostName: "Studio", retry: () => void (usage.retried += 1) };
  render(<SettingsScreen />);
  act(() => screen.getByRole("button", { name: /Couldn’t read usage/ }).click());
  expect(usage.retried).toBe(1);
});

/** Whether a view or one around it is drawn faded. */
function dimmed(node: Element): boolean {
  for (let at: Element | null = node; at; at = at.parentElement) if (/\bopacity-/.test(String(nativeProps.get(at)?.className ?? ""))) return true;
  return false;
}

it("shows an fx monetary balance without an empty allowance or guessed percentage", () => {
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
  usage.current = { accounts: [fx], state: "ready", live: true, readAt: now, now, hostName: "Studio", retry: () => undefined };
  render(<SettingsScreen />);
  expect(screen.getByRole("header", { name: "fx" })).toBeTruthy();
  expect(screen.getByText("AI Gateway balance")).toBeTruthy();
  expect(screen.getByText("$12.50")).toBeTruthy();
  expect(screen.queryByText("No limits reported")).toBeNull();
});
