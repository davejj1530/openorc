import { PHONE_APP } from "@openorc/protocol";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import app from "../app.json" with { type: "json" };
import eas from "../eas.json" with { type: "json" };

const require = createRequire(import.meta.url);
const target = require("../targets/notification-service/expo-target.config.js") as Record<string, unknown>;
const { ios, plugins } = app.expo as { ios: Record<string, unknown>; plugins: unknown[] };

// An update built on newer native code would crash an installed binary, so updates match binaries by native fingerprint.
it("takes over-the-air updates only from this project's production channel, for its own native code", () => {
  expect(app.expo.runtimeVersion).toEqual({ policy: "fingerprint" });
  expect(app.expo.updates.url).toBe(`https://u.expo.dev/${app.expo.extra.eas.projectId}`);
  expect(eas.build.production.channel).toBe("production");
});

it("signs for the team and topic the Mac sends to", () => {
  expect(ios.bundleIdentifier).toBe(PHONE_APP.bundleId);
  expect(ios.appleTeamId).toBe(PHONE_APP.teamId);
});

it("asks Xcode for the sandbox push environment its own signing gives, and builds the extension target", () => {
  expect(plugins).toContainEqual(["expo-notifications", { mode: "development" }]);
  expect(plugins).toContain("@bacons/apple-targets");
});

// An Orcling's text shows as a message with its face, which iOS allows an app that declares messages and has the capability.
it("may show an Orcling's text as a message from it", () => {
  expect(ios.entitlements).toEqual({ "com.apple.developer.usernotifications.communication": true });
  expect((ios.infoPlist as Record<string, unknown>).NSUserActivityTypes).toEqual(["INSendMessageIntent"]);
});

// The app's keys stay in its default group; only the extension names that group, so it can read them.
it("lets only the extension read the app's Keychain group", () => {
  expect(ios.entitlements).not.toHaveProperty("keychain-access-groups");
  expect(target).toEqual({
    type: "notification-service",
    name: "NotificationService",
    bundleIdentifier: ".NotificationService",
    deploymentTarget: "16.4",
    entitlements: { "keychain-access-groups": [`$(AppIdentifierPrefix)${PHONE_APP.bundleId}`] },
  });
});

// The camera and photo plugins take the microphone's sentence out of the app unless they are given it, and iOS ends
// an app that asks for the microphone without one. Dictation asks, so all three say the same sentence.
it("says why it uses the microphone, in one sentence every plugin that writes it agrees on", () => {
  const said = ["expo-camera", "expo-image-picker", "expo-speech-recognition"].map((name) => {
    const plugin = plugins.find((each) => Array.isArray(each) && each[0] === name) as [string, { microphonePermission?: unknown }];
    return plugin[1].microphonePermission;
  });
  expect(typeof said[0]).toBe("string");
  expect(new Set(said).size).toBe(1);
});
