import { describe, expect, it } from "vitest";
import type { Device, DevicePlatformSupport } from "@openorc/protocol";
import { fitFrame, mediaBox, screenAspect, screenRotation } from "./screen-layout";
import { screenPhase, streamable, type ScreenFacts } from "./screen-phase";

const phone = (state: Device["state"], platform: Device["platform"] = "ios"): Device => ({ id: "d", name: "Phone", platform, os: "iOS 26.5", formFactor: "phone", state });
const android: DevicePlatformSupport = { platform: "android", available: true, reason: null, video: { available: false, reason: "Android video needs ffmpeg with libx264." } };
const facts = (patch: Partial<ScreenFacts>): ScreenFacts => ({ device: phone("booted"), operation: undefined, support: undefined, stream: { kind: "connecting" }, ...patch });

describe("screen phase", () => {
  it("follows the device until it is booted, and the stream after", () => {
    expect(screenPhase(facts({ device: phone("shutdown") }))).toEqual({ kind: "shutdown" });
    expect(screenPhase(facts({ device: phone("booting") }))).toEqual({ kind: "starting" });
    expect(screenPhase(facts({ device: phone("shutting-down") }))).toEqual({ kind: "stopping" });
    expect(screenPhase(facts({}))).toEqual({ kind: "starting" });
    expect(screenPhase(facts({ stream: { kind: "streaming" } }))).toEqual({ kind: "streaming" });
    expect(screenPhase(facts({ stream: { kind: "reconnecting", detail: "x" } }))).toEqual({ kind: "reconnecting" });
    expect(screenPhase(facts({ stream: { kind: "failed", reason: "No decoder." } }))).toEqual({ kind: "unavailable", reason: "No decoder." });
  });

  it("shows the user's own start or shutdown before the list catches up", () => {
    expect(screenPhase(facts({ device: phone("shutdown"), operation: { kind: "booting" } }))).toEqual({ kind: "starting" });
    expect(screenPhase(facts({ stream: { kind: "streaming" }, operation: { kind: "stopping" } }))).toEqual({ kind: "stopping" });
  });

  it("explains a running emulator without video and a device that is gone", () => {
    expect(screenPhase(facts({ device: phone("booted", "android"), support: android }))).toEqual({ kind: "unavailable", reason: "Android video needs ffmpeg with libx264." });
    expect(screenPhase(facts({ device: undefined }))).toEqual({ kind: "unavailable", reason: "This device is no longer on this Mac." });
  });

  it("streams only a booted device with nothing in flight and video available", () => {
    expect(streamable({ device: phone("booted"), operation: undefined, support: undefined })).toBe(true);
    expect(streamable({ device: phone("booting"), operation: undefined, support: undefined })).toBe(false);
    expect(streamable({ device: phone("booted"), operation: { kind: "stopping" }, support: undefined })).toBe(false);
    expect(streamable({ device: phone("booted", "android"), operation: undefined, support: android })).toBe(false);
    expect(streamable({ device: phone("booted"), operation: { kind: "failed", action: "shut down", error: "x" }, support: undefined })).toBe(true);
  });
});

describe("screen layout", () => {
  it("fits the device's shape to the tab, by height or by width", () => {
    expect(fitFrame(0.5, { width: 400, height: 600 })).toEqual({ width: 300, height: 600 });
    expect(fitFrame(2, { width: 400, height: 600 })).toEqual({ width: 400, height: 200 });
    expect(fitFrame(0.5, { width: 0, height: 600 })).toEqual({ width: 0, height: 0 });
  });

  it("turns iOS's portrait framebuffer to the way the device faces", () => {
    const sideways = { width: 1206, height: 2622, orientation: "landscape_left" } as const;
    expect(screenAspect({ platform: "ios", formFactor: "phone" }, sideways)).toBeCloseTo(2622 / 1206);
    expect(screenAspect({ platform: "ios", formFactor: "tablet" }, null)).toBe(3 / 4);
    expect(screenRotation("ios", sideways)).toBe(90);
    expect(screenRotation("android", sideways)).toBe(0);
    expect(mediaBox({ width: 400, height: 200 }, 90)).toEqual({ width: 200, height: 400, left: 100, top: -100, transform: "rotate(90deg)" });
    expect(mediaBox({ width: 200, height: 400 }, 0)).toEqual({ width: 200, height: 400, left: 0, top: 0 });
  });
});
