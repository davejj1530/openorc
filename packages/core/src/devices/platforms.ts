import { access, constants, realpath } from "node:fs/promises";
import path from "node:path";
import type { DevicePlatformSupport } from "@openorc/protocol";
import { resolveBinary } from "../services/shell-environment.js";
import type { DeviceSystem, ProcessEnv } from "./system.js";

/** An Android SDK with everything the hub drives emulators with. */
export interface AndroidSdk {
  root: string;
  adb: string;
  emulator: string;
}

export interface PlatformReport {
  platforms: DevicePlatformSupport[];
  sdk: AndroidSdk | null;
}

const IOS_NEEDS_XCODE = "iOS needs Xcode.";
const ANDROID_NEEDS_SDK = "Android needs the SDK platform-tools, emulator and cmdline-tools/latest.";
const VIDEO_NEEDS_FFMPEG = "Android video needs ffmpeg with libx264.";

/** What this machine can run. `searchPath` is the login shell's PATH. */
export async function probePlatforms(system: DeviceSystem, env: ProcessEnv, searchPath: string): Promise<PlatformReport> {
  const [ios, sdk] = await Promise.all([iosSupport(system, env), findAndroidSdk(system, env, searchPath)]);
  const android: DevicePlatformSupport = sdk
    ? { platform: "android", available: true, reason: null, video: await androidVideo(system, env, searchPath) }
    : { platform: "android", available: false, reason: ANDROID_NEEDS_SDK };
  return { platforms: [ios, android], sdk };
}

async function iosSupport(system: DeviceSystem, env: ProcessEnv): Promise<DevicePlatformSupport> {
  if (system.platform !== "darwin") return { platform: "ios", available: false, reason: "iOS needs a Mac with Xcode." };
  const result = await system.run("xcrun", ["simctl", "help"], { env, timeoutMs: 15_000 });
  return result.code === 0 ? { platform: "ios", available: true, reason: null } : { platform: "ios", available: false, reason: IOS_NEEDS_XCODE };
}

/**
 * The environment variables first, then the default install folders, then an adb on PATH resolved to its SDK. A login
 * shell's ANDROID_HOME never reaches an app opened from the Dock, which is why PATH counts too.
 */
async function findAndroidSdk(system: DeviceSystem, env: ProcessEnv, searchPath: string): Promise<AndroidSdk | null> {
  const candidates = [env["ANDROID_HOME"], env["ANDROID_SDK_ROOT"], path.join(system.home, "Library", "Android", "sdk"), path.join(system.home, "Android", "Sdk")];
  for (const root of candidates) {
    const sdk = root?.trim() ? await completeSdk(root.trim()) : null;
    if (sdk) return sdk;
  }
  const adb = await resolveBinary("adb", searchPath);
  if (!adb) return null;
  const resolved = await realpath(adb).catch(() => adb);
  return completeSdk(path.dirname(path.dirname(resolved)));
}

async function completeSdk(root: string): Promise<AndroidSdk | null> {
  const adb = path.join(root, "platform-tools", "adb");
  const emulator = path.join(root, "emulator", "emulator");
  const avdmanager = path.join(root, "cmdline-tools", "latest", "bin", "avdmanager");
  const present = await Promise.all([adb, emulator, avdmanager].map(executable));
  return present.every(Boolean) ? { root, adb, emulator } : null;
}

async function androidVideo(system: DeviceSystem, env: ProcessEnv, searchPath: string): Promise<{ available: boolean; reason: string | null }> {
  const ffmpeg = env["SERVE_EMU_FFMPEG"] || (await resolveBinary("ffmpeg", searchPath));
  if (!ffmpeg) return { available: false, reason: VIDEO_NEEDS_FFMPEG };
  const encoders = await system.run(ffmpeg, ["-hide_banner", "-encoders"], { env, timeoutMs: 15_000 });
  return encoders.code === 0 && /\blibx264\b/.test(encoders.stdout) ? { available: true, reason: null } : { available: false, reason: VIDEO_NEEDS_FFMPEG };
}

/** The environment the hub and agent-device run with: the SDK's tools on PATH, so `adb` and `emulator` resolve. */
export function toolEnvironment(env: ProcessEnv, sdk: AndroidSdk | null): ProcessEnv {
  if (!sdk) return env;
  const pathEntries = [path.dirname(sdk.adb), path.dirname(sdk.emulator), env["PATH"] ?? ""].filter(Boolean);
  return { ...env, ANDROID_HOME: sdk.root, PATH: pathEntries.join(path.delimiter) };
}

async function executable(file: string): Promise<boolean> {
  return access(file, constants.X_OK).then(
    () => true,
    () => false,
  );
}
