import type { Device, DevicePlatform, DevicePlatformSupport } from "@openorc/protocol";
import type { DeviceOperation } from "./operations";

export type DeviceGroup = { os: string; platform: DevicePlatform; devices: Device[] };

/** The picker's groups, one per OS version. The core lists devices in picker order, so grouping keeps it. */
export function groupDevices(devices: Device[]): DeviceGroup[] {
  const groups = new Map<string, DeviceGroup>();
  for (const device of devices) {
    const key = `${device.platform}\u0000${device.os}`;
    const group = groups.get(key) ?? { os: device.os, platform: device.platform, devices: [] };
    group.devices.push(device);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** A row's state in a word, shown only when the device is not simply shut down. */
export type RowState = { word: string; tone: "ok" | "muted" | "bad"; detail?: string };

export function rowState(device: Device, operation: DeviceOperation | undefined): RowState | null {
  if (operation?.kind === "booting" || device.state === "booting") return { word: "Starting", tone: "muted" };
  if (operation?.kind === "stopping" || device.state === "shutting-down") return { word: "Shutting down", tone: "muted" };
  if (operation?.kind === "failed") return { word: `Could not ${operation.action}`, tone: "bad", detail: operation.error };
  return device.state === "booted" ? { word: "Running", tone: "ok" } : null;
}

/** The row's quick action: Start for a device at rest, Shut down for a running one, nothing while either runs. */
export function rowAction(device: Device, operation: DeviceOperation | undefined): "start" | "shut down" | null {
  if (operation?.kind === "booting" || operation?.kind === "stopping") return null;
  if (device.state === "shutdown") return "start";
  return device.state === "booted" ? "shut down" : null;
}

export const blockedPlatforms = (platforms: DevicePlatformSupport[]): Array<{ platform: DevicePlatform; reason: string }> =>
  platforms.flatMap((support) => (!support.available && support.reason ? [{ platform: support.platform, reason: support.reason }] : []));
