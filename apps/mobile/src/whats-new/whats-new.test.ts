import { expect, it } from "vitest";
import type { KeyValue } from "../scratch-store";
import { PHONE_CLOUD_RELEASE, whatsNewAtLaunch } from "./whats-new";

const store = (seen?: string): KeyValue & { seen: () => string | undefined } => {
  const values = new Map<string, string>(seen ? [["seen", seen]] : []);
  return { getString: (key) => values.get(key), set: (key, value) => void values.set(key, value), remove: (key) => void values.delete(key), seen: () => values.get("seen") };
};

it("comes once to a phone that was paired before, after the update to the cloud release, until it is closed", () => {
  const kept = store();
  const launch = whatsNewAtLaunch(kept, PHONE_CLOUD_RELEASE, true);
  expect(launch.take()).toBe(true);
  expect(launch.take()).toBe(false);
  expect(kept.seen()).toBeUndefined();
  // Not closed: the next launch brings them again.
  expect(whatsNewAtLaunch(kept, PHONE_CLOUD_RELEASE, true).take()).toBe(true);
  launch.close();
  expect(kept.seen()).toBe(PHONE_CLOUD_RELEASE);
  expect(whatsNewAtLaunch(kept, PHONE_CLOUD_RELEASE, true).take()).toBe(false);
  expect(whatsNewAtLaunch(kept, "1.3.1", true).take()).toBe(false);
});

it("never comes to a fresh install, which is settled at once, so pairing later brings nothing", () => {
  const kept = store();
  expect(whatsNewAtLaunch(kept, PHONE_CLOUD_RELEASE, false).take()).toBe(false);
  expect(kept.seen()).toBe(PHONE_CLOUD_RELEASE);
  expect(whatsNewAtLaunch(kept, PHONE_CLOUD_RELEASE, true).take()).toBe(false);
});

it("waits for the cloud release, and comes to a phone that settled an earlier version", () => {
  const kept = store();
  expect(whatsNewAtLaunch(kept, "1.2.0", true).take()).toBe(false);
  expect(kept.seen()).toBe("1.2.0");
  expect(whatsNewAtLaunch(kept, "1.4.0", true).take()).toBe(true);
  expect(whatsNewAtLaunch(store(), null, true).take()).toBe(false);
});
