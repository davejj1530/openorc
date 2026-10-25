import type { PushAlerts, PushEnvironment, PushRegistration, PushSenderState } from "@openorc/protocol";

/** Which alerts this phone takes. "Off" registers nothing. */
export type AlertChoice = PushAlerts | "off";
export interface AlertPrefs {
  choice: AlertChoice;
  sound: boolean;
}
export const DEFAULT_PREFS: AlertPrefs = { choice: "all", sound: true };

/** What iOS says about alerts for this app. */
export type Permission = "granted" | "denied" | "undetermined";

/** What a Mac said when this phone registered: whether it can send, or "update" when it has no phone alerts at all. */
export type MacSender = PushSenderState | "update";

/** The registration a Mac should hold for this phone. Null stops alerts. */
export function registrationFor(prefs: AlertPrefs, permission: Permission | null, token: string | null, environment: PushEnvironment): PushRegistration | null {
  if (prefs.choice === "off" || permission !== "granted" || !token) return null;
  return { token, environment, alerts: prefs.choice, sound: prefs.sound };
}

/** The build's aps-environment, from its provisioning profile: only a development profile takes the sandbox. */
export const environmentOf = (apsEnvironment: string | null): PushEnvironment => (apsEnvironment === "development" ? "sandbox" : "production");

/** The choice the row shows: alerts iOS has not allowed are off, whatever was chosen. */
export const shownChoice = (permission: Permission | null, choice: AlertChoice): AlertChoice => (permission === "granted" ? choice : "off");

const senderLines: Record<MacSender, string | null> = {
  ready: null,
  "no-key": "Your Mac has no push key.",
  refused: "Apple refused your Mac’s push key.",
  update: "Update OpenOrc on your Mac.",
};

/** The line under the row, only when something stops alerts the person did not turn off themselves. */
export function detailFor(permission: Permission | null, choice: AlertChoice, sender: MacSender | null): string | null {
  if (permission === "denied") return "Turned off in iOS Settings.";
  if (choice === "off" || !sender) return null;
  return senderLines[sender];
}
