import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSystem } from "./fixtures/fake-system.js";
import { DeviceInventory, describeAvd, parseSimctl } from "./inventory.js";
import { probePlatforms } from "./platforms.js";

let dir: string;
let system: FakeSystem;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openorc-inventory-test-"));
  system = new FakeSystem(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function executable(file: string, contents = "#!/bin/sh\n"): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
  await chmod(file, 0o755);
}

async function androidSdk(root: string): Promise<void> {
  for (const file of ["platform-tools/adb", "emulator/emulator", "cmdline-tools/latest/bin/avdmanager"]) await executable(path.join(root, file));
}

const runtimes = JSON.stringify({
  runtimes: [
    { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2", name: "iOS 18.2", platform: "iOS", isAvailable: true },
    { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5", name: "iOS 26.5", platform: "iOS", isAvailable: true },
    { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-26-0", name: "watchOS 26.0", platform: "watchOS", isAvailable: true },
  ],
});
const simulators = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [{ udid: "OLD", name: "iPhone 16", state: "Shutdown", isAvailable: true }],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
      { udid: "PAD", name: "iPad Pro 13-inch (M5)", state: "Booting", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5", isAvailable: true },
      { udid: "PHONE", name: "iPhone 17 Pro", state: "Booted", isAvailable: true },
      { udid: "GONE", name: "iPhone 15", state: "Shutdown", isAvailable: false },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [{ udid: "WATCH", name: "Apple Watch Ultra 3", state: "Shutdown", isAvailable: true }],
  },
});

describe("parseSimctl", () => {
  it("keeps available iOS simulators only, with their OS, form factor and state", () => {
    expect(parseSimctl(runtimes, simulators)).toEqual([
      { id: "OLD", platform: "ios", name: "iPhone 16", os: "iOS 18.2", formFactor: "phone", state: "shutdown" },
      { id: "PAD", platform: "ios", name: "iPad Pro 13-inch (M5)", os: "iOS 26.5", formFactor: "tablet", state: "booting" },
      { id: "PHONE", platform: "ios", name: "iPhone 17 Pro", os: "iOS 26.5", formFactor: "phone", state: "booted" },
    ]);
  });
});

describe("describeAvd", () => {
  it("reads the API level, display name and tablets from an AVD's config", () => {
    expect(describeAvd("Pixel_9", "avd.ini.displayname=Pixel 9\nimage.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\nhw.device.name=pixel_9\n", "")).toEqual({
      id: "Pixel_9",
      platform: "android",
      name: "Pixel 9",
      os: "Android API 36",
      formFactor: "phone",
    });
    expect(describeAvd("Pixel_Tablet_API_34", "hw.device.name = pixel_tablet\n", "target=android-34\n")).toMatchObject({ name: "Pixel Tablet API 34", os: "Android API 34", formFactor: "tablet" });
  });
});

describe("DeviceInventory", () => {
  it("lists simulators and emulators, newest OS first and phones before tablets, with running emulators' serials", async () => {
    const sdk = path.join(dir, "Library", "Android", "sdk");
    await androidSdk(sdk);
    const avds = path.join(dir, ".android", "avd");
    await mkdir(path.join(avds, "Pixel_9.avd"), { recursive: true });
    await writeFile(path.join(avds, "Pixel_9.avd", "config.ini"), "avd.ini.displayname=Pixel 9\nimage.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\n");
    await mkdir(path.join(avds, "Small_Phone.avd"), { recursive: true });
    await writeFile(path.join(avds, "Small_Phone.avd", "config.ini"), "image.sysdir.1=system-images/android-35/default/arm64-v8a/\n");
    system.on((call) => call.args.join(" ") === "simctl list runtimes -j", { stdout: runtimes });
    system.on((call) => call.args.join(" ") === "simctl list devices available -j", { stdout: simulators });
    system.on((call) => call.args[0] === "-list-avds", { stdout: "INFO    | Storing crashdata in: /tmp/x\nPixel_9\nSmall_Phone\n" });
    system.on((call) => call.args[0] === "devices", { stdout: "List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\n\n" });
    system.on((call) => call.args.join(" ") === "-s emulator-5554 emu avd name", { stdout: "Pixel_9\nOK\n" });
    system.on((call) => call.args.join(" ") === "-s emulator-5556 emu avd name", { stdout: "Small_Phone\nOK\n" });
    system.on((call) => call.args.includes("sys.boot_completed"), { stdout: "1\n" });

    const report = await probePlatforms(system, { PATH: "/usr/bin" }, "/usr/bin");
    const inventory = await new DeviceInventory(system).read({ ios: true, sdk: report.sdk, env: {} });
    expect(inventory.devices.map((device) => `${device.os} ${device.name} ${device.state}`)).toEqual([
      "iOS 26.5 iPhone 17 Pro booted",
      "iOS 26.5 iPad Pro 13-inch (M5) booting",
      "iOS 18.2 iPhone 16 shutdown",
      "Android API 36 Pixel 9 booted",
      "Android API 35 Small Phone booting",
    ]);
    expect([...inventory.serials]).toEqual([
      ["Pixel_9", "emulator-5554"],
      ["Small_Phone", "emulator-5556"],
    ]);
    expect(inventory.warnings).toEqual([]);
  });

  it("keeps what it could list and warns about the rest", async () => {
    system.on((call) => call.command === "xcrun", { code: 1 });
    const inventory = await new DeviceInventory(system).read({ ios: true, sdk: null, env: {} });
    expect(inventory).toEqual({ devices: [], warnings: ["Could not list iOS simulators."], serials: new Map() });
  });
});

describe("probePlatforms", () => {
  it("needs a Mac with Xcode for iOS", async () => {
    system.platform = "linux";
    expect((await probePlatforms(system, {}, "")).platforms[0]).toEqual({ platform: "ios", available: false, reason: "iOS needs a Mac with Xcode." });
    system.platform = "darwin";
    system.on((call) => call.command === "xcrun", { code: 72 });
    expect((await probePlatforms(system, {}, "")).platforms[0]).toEqual({ platform: "ios", available: false, reason: "iOS needs Xcode." });
  });

  it("finds the Android SDK from an adb on PATH, and needs all of its tools", async () => {
    const sdk = path.join(dir, "sdk");
    await androidSdk(sdk);
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    await symlink(path.join(sdk, "platform-tools", "adb"), path.join(bin, "adb"));
    await executable(path.join(bin, "ffmpeg"));
    system.on((call) => call.command.endsWith("ffmpeg"), { stdout: " V....D libx264  libx264 H.264 / AVC\n" });
    expect((await probePlatforms(system, {}, bin)).platforms[1]).toEqual({ platform: "android", available: true, reason: null, video: { available: true, reason: null } });

    system.on((call) => call.command.endsWith("ffmpeg"), { stdout: " V....D h264_videotoolbox\n" });
    expect((await probePlatforms(system, {}, bin)).platforms[1]?.video).toEqual({ available: false, reason: "Android video needs ffmpeg with libx264." });

    await rm(path.join(sdk, "cmdline-tools"), { recursive: true });
    expect((await probePlatforms(system, {}, bin)).platforms[1]).toEqual({ platform: "android", available: false, reason: "Android needs the SDK platform-tools, emulator and cmdline-tools/latest." });
  });
});
