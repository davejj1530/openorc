import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Device, DeviceState } from "@openorc/protocol";
import type { AndroidSdk } from "./platforms.js";
import type { DeviceSystem, ProcessEnv } from "./system.js";

export interface Inventory {
  devices: Device[];
  warnings: string[];
  /** AVD name to the serial of its running emulator. */
  serials: ReadonlyMap<string, string>;
}

const SimctlRuntimes = z.object({
  runtimes: z.array(z.object({ identifier: z.string(), name: z.string(), platform: z.string().optional(), isAvailable: z.boolean().optional() })),
});
const SimctlDevices = z.object({
  devices: z.record(z.string(), z.array(z.object({ udid: z.string(), name: z.string(), state: z.string(), deviceTypeIdentifier: z.string().optional(), isAvailable: z.boolean().optional() }))),
});

const simulatorStates: Record<string, DeviceState> = { Booted: "booted", Booting: "booting", "Shutting Down": "shutting-down" };

/** iOS simulators from `simctl list -j` output. Only iOS runtimes: no watchOS, tvOS or visionOS. */
export function parseSimctl(runtimesJson: string, devicesJson: string): Device[] {
  const runtimes = SimctlRuntimes.parse(JSON.parse(runtimesJson)).runtimes.filter((runtime) => runtime.isAvailable !== false && isIosRuntime(runtime));
  const byRuntime = SimctlDevices.parse(JSON.parse(devicesJson)).devices;
  return runtimes.flatMap((runtime) =>
    (byRuntime[runtime.identifier] ?? [])
      .filter((device) => device.isAvailable !== false)
      .map((device) => ({
        id: device.udid,
        platform: "ios" as const,
        name: device.name,
        os: runtime.name,
        formFactor: /ipad/i.test(`${device.deviceTypeIdentifier ?? ""} ${device.name}`) ? ("tablet" as const) : ("phone" as const),
        state: simulatorStates[device.state] ?? "shutdown",
      })),
  );
}

function isIosRuntime(runtime: { identifier: string; platform?: string | undefined }): boolean {
  return runtime.platform ? runtime.platform === "iOS" : /\.iOS-/.test(runtime.identifier);
}

function iniValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return values;
}

/** An AVD as the picker shows it, from its `config.ini` and the `<name>.ini` beside its folder. */
export function describeAvd(name: string, config: string, ini: string): Omit<Device, "state"> {
  const values = iniValues(config);
  const outer = iniValues(ini);
  const api = /android-([A-Za-z0-9.]+)/.exec(values.get("image.sysdir.1") ?? "")?.[1] ?? /android-([A-Za-z0-9.]+)/.exec(outer.get("target") ?? values.get("target") ?? "")?.[1];
  const displayName = values.get("avd.ini.displayname") || name.replaceAll("_", " ");
  const tablet = /tablet/i.test(`${values.get("hw.device.name") ?? ""} ${displayName}`);
  return { id: name, platform: "android", name: displayName, os: api ? `Android API ${api}` : "Android", formFactor: tablet ? "tablet" : "phone" };
}

function avdHome(env: ProcessEnv, home: string): string {
  if (env["ANDROID_AVD_HOME"]) return env["ANDROID_AVD_HOME"];
  if (env["ANDROID_USER_HOME"]) return path.join(env["ANDROID_USER_HOME"], "avd");
  return path.join(home, ".android", "avd");
}

async function readAvd(name: string, root: string): Promise<Omit<Device, "state">> {
  const ini = await readFile(path.join(root, `${name}.ini`), "utf8").catch(() => "");
  const folder = iniValues(ini).get("path") || path.join(root, `${name}.avd`);
  const config = await readFile(path.join(folder, "config.ini"), "utf8").catch(() => "");
  return describeAvd(name, config, ini);
}

export class DeviceInventory {
  constructor(private readonly system: DeviceSystem) {}

  /** Every simulator and emulator, sorted the way the picker groups them. A platform that is unavailable lists nothing. */
  async read(input: { ios: boolean; sdk: AndroidSdk | null; env: ProcessEnv }): Promise<Inventory> {
    const warnings: string[] = [];
    const none = { devices: [] as Device[], serials: new Map<string, string>() };
    const failed =
      <T>(warning: string, fallback: T) =>
      () => {
        warnings.push(warning);
        return fallback;
      };
    const [ios, android] = await Promise.all([
      input.ios ? this.simulators(input.env).catch(failed("Could not list iOS simulators.", [])) : [],
      input.sdk ? this.emulators(input.sdk, input.env).catch(failed("Could not list Android emulators.", none)) : none,
    ]);
    return { devices: sortDevices([...ios, ...android.devices]), warnings, serials: android.serials };
  }

  private async simulators(env: ProcessEnv): Promise<Device[]> {
    const [runtimes, devices] = await Promise.all([
      this.system.run("xcrun", ["simctl", "list", "runtimes", "-j"], { env, timeoutMs: 20_000 }),
      this.system.run("xcrun", ["simctl", "list", "devices", "available", "-j"], { env, timeoutMs: 20_000 }),
    ]);
    if (runtimes.code !== 0 || devices.code !== 0) throw new Error("simctl failed");
    return parseSimctl(runtimes.stdout, devices.stdout);
  }

  private async emulators(sdk: AndroidSdk, env: ProcessEnv): Promise<{ devices: Device[]; serials: Map<string, string> }> {
    const listed = await this.system.run(sdk.emulator, ["-list-avds"], { env, timeoutMs: 20_000 });
    if (listed.code !== 0) throw new Error("emulator -list-avds failed");
    const names = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z0-9._-]+$/.test(line));
    const root = avdHome(env, this.system.home);
    const [avds, running] = await Promise.all([Promise.all(names.map((name) => readAvd(name, root))), this.running(sdk, env)]);
    const serials = new Map([...running].map(([name, emulator]) => [name, emulator.serial]));
    return { devices: avds.map((avd) => ({ ...avd, state: running.get(avd.id)?.state ?? "shutdown" })), serials };
  }

  /** Running emulators by AVD name. */
  private async running(sdk: AndroidSdk, env: ProcessEnv): Promise<Map<string, { serial: string; state: DeviceState }>> {
    const listed = await this.system.run(sdk.adb, ["devices"], { env, timeoutMs: 10_000 });
    const attached = [...listed.stdout.matchAll(/^(emulator-\d+)\s+(\S+)/gm)].map((match) => ({ serial: match[1]!, online: match[2] === "device" }));
    const found = await Promise.all(
      attached.map(async ({ serial, online }) => {
        const name = await this.system.run(sdk.adb, ["-s", serial, "emu", "avd", "name"], { env, timeoutMs: 10_000 });
        const avd = name.code === 0 ? name.stdout.split(/\r?\n/)[0]?.trim() : undefined;
        if (!avd) return null;
        const booted = online && (await this.system.run(sdk.adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { env, timeoutMs: 10_000 })).stdout.trim() === "1";
        return [avd, { serial, state: booted ? "booted" : "booting" }] as const;
      }),
    );
    return new Map(found.filter((entry) => entry !== null));
  }
}

function osVersion(os: string): number[] {
  return (os.match(/\d+/g) ?? []).map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

const platformOrder = { ios: 0, android: 1 };
const formFactorOrder = { phone: 0, tablet: 1 };

/** iOS before Android, newest OS first, phones before tablets, then by name. */
export function sortDevices(devices: Device[]): Device[] {
  return [...devices].sort(
    (a, b) =>
      platformOrder[a.platform] - platformOrder[b.platform] ||
      compareVersions(osVersion(b.os), osVersion(a.os)) ||
      formFactorOrder[a.formFactor] - formFactorOrder[b.formFactor] ||
      a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}
