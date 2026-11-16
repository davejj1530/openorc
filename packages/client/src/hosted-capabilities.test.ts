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
