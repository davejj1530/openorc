import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, detailFor, environmentOf, registrationFor, shownChoice } from "./registration";

const token = "ab".repeat(32);

describe("the registration a Mac holds for this phone", () => {
  it.each([
    { name: "all, with sound", prefs: { choice: "all", sound: true }, permission: "granted", token, want: { token, environment: "sandbox", alerts: "all", sound: true } },
    { name: "needs you, quiet", prefs: { choice: "needs-you", sound: false }, permission: "granted", token, want: { token, environment: "sandbox", alerts: "needs-you", sound: false } },
    { name: "off", prefs: { choice: "off", sound: true }, permission: "granted", token, want: null },
    { name: "never allowed", prefs: { choice: "all", sound: true }, permission: "undetermined", token, want: null },
    { name: "turned off in iOS", prefs: { choice: "all", sound: true }, permission: "denied", token, want: null },
    { name: "no token yet", prefs: { choice: "all", sound: true }, permission: "granted", token: null, want: null },
  ] as const)("$name", ({ prefs, permission, token, want }) => {
    expect(registrationFor(prefs, permission, token, "sandbox")).toEqual(want);
  });

  it("starts with every alert and its sound", () => {
    expect(DEFAULT_PREFS).toEqual({ choice: "all", sound: true });
  });

  it("takes the sandbox only for a development profile", () => {
    expect(environmentOf("development")).toBe("sandbox");
    expect(environmentOf("production")).toBe("production");
    expect(environmentOf(null)).toBe("production");
  });
});

describe("what the Notifications row says", () => {
  it.each([
    { permission: "granted", choice: "all", shown: "all" },
    { permission: "granted", choice: "needs-you", shown: "needs-you" },
    { permission: "granted", choice: "off", shown: "off" },
    { permission: "undetermined", choice: "all", shown: "off" },
    { permission: "denied", choice: "needs-you", shown: "off" },
    { permission: null, choice: "all", shown: "off" },
  ] as const)("shows $shown when iOS says $permission and the choice is $choice", ({ permission, choice, shown }) => {
    expect(shownChoice(permission, choice)).toBe(shown);
  });

  it.each([
    { name: "iOS turned them off", permission: "denied", choice: "all", sender: "ready", line: "Turned off in iOS Settings." },
    { name: "iOS before any Mac said", permission: "denied", choice: "off", sender: null, line: "Turned off in iOS Settings." },
    { name: "no push key", permission: "granted", choice: "all", sender: "no-key", line: "Your Mac has no push key." },
    { name: "not yet asked, no key", permission: "undetermined", choice: "all", sender: "no-key", line: "Your Mac has no push key." },
    { name: "a refused key", permission: "granted", choice: "needs-you", sender: "refused", line: "Apple refused your Mac’s push key." },
    { name: "an older Mac", permission: "granted", choice: "all", sender: "update", line: "Update OpenOrc on your Mac." },
    { name: "all well", permission: "granted", choice: "all", sender: "ready", line: null },
    { name: "the person chose off", permission: "granted", choice: "off", sender: "no-key", line: null },
    { name: "the Mac has not answered yet", permission: "granted", choice: "all", sender: null, line: null },
  ] as const)("$name", ({ permission, choice, sender, line }) => {
    expect(detailFor(permission, choice, sender)).toBe(line);
  });
});
