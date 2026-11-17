import { HOSTED_REASONS, type HostedCapabilities } from "@openorc/protocol";
import { expect, it } from "vitest";
import { hostedControlReason } from "./hosted-capabilities.js";

const cloud = { owner: { brain: "hosted", reach: "live" } } as never;
const features = (terminal: HostedCapabilities["features"]["terminal"]): HostedCapabilities => ({ version: 1, features: { terminal } });

it("offers a cloud thread's terminal only once its server says so, with the server's reason otherwise", () => {
  expect(hostedControlReason(cloud, "terminal", features({ available: true }))).toBeNull();
  expect(hostedControlReason(cloud, "terminal", features({ available: false, reason: "The terminal isn't available in cloud threads yet." }))).toBe(
    "The terminal isn't available in cloud threads yet.",
  );
  expect(hostedControlReason(cloud, "terminal", features(undefined))).toBe(HOSTED_REASONS.terminal);
  expect(hostedControlReason(cloud, "terminal")).toBe("Checking cloud features…");
  expect(hostedControlReason({ owner: { brain: "hosted", reach: "offline" } } as never, "terminal", features({ available: true }))).toBe("OpenOrc Cloud can't be reached.");
  expect(hostedControlReason({ owner: null } as never, "terminal")).toBeNull();
});

it("offers a person's subthread in a cloud thread only once its server says so, with the server's reason otherwise", () => {
  const served = (personSubthreads: HostedCapabilities["features"]["personSubthreads"]): HostedCapabilities => ({ version: 1, features: { personSubthreads } });
  expect(hostedControlReason(cloud, "personSubthreads", served({ available: true }))).toBeNull();
  expect(hostedControlReason(cloud, "personSubthreads", served({ available: false, reason: "New subthreads aren't available in cloud threads yet." }))).toBe(
    "New subthreads aren't available in cloud threads yet.",
  );
  expect(hostedControlReason(cloud, "personSubthreads", served(undefined))).toBe(HOSTED_REASONS.personSubthreads);
  // A control the server doesn't answer for stays held in the app's words, whatever it answers.
  expect(hostedControlReason(cloud, "fork", served({ available: true }))).toBe(HOSTED_REASONS.fork);
});

it("offers Compact in a cloud thread only once its server says so, and an older server's thread keeps the app's words", () => {
  const served = (compact: HostedCapabilities["features"]["compact"]): HostedCapabilities => ({ version: 1, features: { compact } });
  expect(hostedControlReason(cloud, "compact", served({ available: true }))).toBeNull();
  expect(hostedControlReason(cloud, "compact", served(undefined))).toBe(HOSTED_REASONS.compact);
  expect(hostedControlReason(cloud, "compact")).toBe("Checking cloud features…");
});
