// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import type { AlertsState } from "../notifications/alerts";
import type { AlertPrefs, MacSender, Permission } from "../notifications/registration";
import { felt } from "../test-fixtures/haptics";
import { opened } from "../test-fixtures/react-native";

const studio = { id: "studio", name: "Studio" };
const phone = vi.hoisted(() => ({
  state: null as unknown as AlertsState,
  link: null as unknown as LinkState,
  chose: [] as string[],
  sounds: [] as boolean[],
}));
vi.mock("../client", () => ({
  alerts: {
    subscribe: () => () => undefined,
    getState: () => phone.state,
    choose: async (choice: string) => void phone.chose.push(choice),
    setSound: async (sound: boolean) => void phone.sounds.push(sound),
  },
  useLinkState: () => phone.link,
}));

const { NotificationsRow } = await import("./NotificationsRow");

function given(permission: Permission | null, prefs: Partial<AlertPrefs> = {}, sender: MacSender | null = "ready") {
  phone.state = { permission, prefs: { choice: "all", sound: true, ...prefs }, senders: new Map(sender ? [["studio", sender]] : []) };
}

beforeEach(() => {
  felt.length = 0;
  opened.length = 0;
  phone.chose = [];
  phone.sounds = [];
  phone.link = { kind: "connected", mac: studio, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };
  given("granted");
});
afterEach(cleanup);

const choices = () => screen.getAllByRole("menuitemradio").map((item) => [item.textContent, item.getAttribute("aria-checked")]);
const sound = () => screen.getByRole("switch", { name: "Sound" });

describe("the Notifications row", () => {
  it.each([
    { permission: "granted", choice: "all", shown: "All" },
    { permission: "granted", choice: "needs-you", shown: "Needs you" },
    { permission: "granted", choice: "off", shown: "Off" },
    { permission: "undetermined", choice: "all", shown: "Off" },
    { permission: null, choice: "needs-you", shown: "Off" },
  ] as const)("shows $shown when iOS says $permission and the choice is $choice, and opens iOS's menu", ({ permission, choice, shown }) => {
    given(permission, { choice });
    render(<NotificationsRow />);
    act(() => screen.getByRole("button", { name: `Notifications, ${shown}` }).click());
    expect(choices()).toEqual(["All", "Needs you", "Off"].map((label) => [label, String(label === shown)]));
    expect(sound().getAttribute("aria-disabled")).toBe(String(shown === "Off"));
    expect(screen.queryByText(/Settings\.$|push key\.$|on your Mac\.$/)).toBeNull();
  });

  it("saves a choice and its sound with the select haptic", () => {
    render(<NotificationsRow />);
    act(() => screen.getByRole("button", { name: "Notifications, All" }).click());
    act(() => screen.getByRole("menuitemradio", { name: "Needs you" }).click());
    act(() => sound().click());
    expect(phone.chose).toEqual(["needs-you"]);
    expect(phone.sounds).toEqual([false]);
    expect(felt).toEqual(["selection", "selection"]);
    act(() => screen.getByRole("menuitemradio", { name: "All" }).click());
    expect(phone.chose).toEqual(["needs-you"]);
  });

  it("sends the person to iOS Settings once iOS turned alerts off, and says so to VoiceOver too", () => {
    given("denied");
    render(<NotificationsRow />);
    expect(screen.getByText("Turned off in iOS Settings.")).toBeTruthy();
    act(() => screen.getByRole("button", { name: "Notifications, Off, Turned off in iOS Settings." }).click());
    expect(opened).toEqual(["settings"]);
    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });

  it.each([
    { sender: "no-key", line: "Your Mac has no push key." },
    { sender: "refused", line: "Apple refused your Mac’s push key." },
    { sender: "update", line: "Update OpenOrc on your Mac." },
  ] as const)("says why nothing arrives when the shown Mac answered $sender, on screen and to VoiceOver", ({ sender, line }) => {
    given("granted", {}, sender);
    render(<NotificationsRow />);
    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.getByRole("button", { name: `Notifications, All, ${line}` })).toBeTruthy();
  });

  it("speaks for the shown Mac only", () => {
    given("granted", {}, null);
    phone.state = { ...phone.state, senders: new Map([["laptop", "no-key"]]) };
    render(<NotificationsRow />);
    expect(screen.queryByText("Your Mac has no push key.")).toBeNull();
  });
});
