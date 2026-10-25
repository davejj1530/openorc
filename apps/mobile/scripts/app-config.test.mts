import { PHONE_APP } from "@openorc/protocol";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import app from "../app.json" with { type: "json" };

const require = createRequire(import.meta.url);
const target = require("../targets/notification-service/expo-target.config.js") as Record<string, unknown>;
const { ios, plugins } = app.expo as { ios: Record<string, unknown>; plugins: unknown[] };

it("signs for the team and topic the Mac sends to", () => {
  expect(ios.bundleIdentifier).toBe(PHONE_APP.bundleId);
  expect(ios.appleTeamId).toBe(PHONE_APP.teamId);
});

it("asks Xcode for the sandbox push environment its own signing gives, and builds the extension target", () => {
  expect(plugins).toContainEqual(["expo-notifications", { mode: "development" }]);
  expect(plugins).toContain("@bacons/apple-targets");
});

// The app's keys stay in its default group; only the extension names that group, so it can read them.
it("lets only the extension read the app's Keychain group", () => {
  expect(ios.entitlements).toBeUndefined();
  expect(target).toEqual({
    type: "notification-service",
    name: "NotificationService",
    bundleIdentifier: ".NotificationService",
    deploymentTarget: "16.4",
    entitlements: { "keychain-access-groups": [`$(AppIdentifierPrefix)${PHONE_APP.bundleId}`] },
  });
});
