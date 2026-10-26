import type { Device, DevicePanelPush, DevicePlatformSupport, DeviceSettings, DeviceToolInput, DeviceToolResult } from "@openorc/protocol";
import { howTo, sessionName } from "./agent-device.js";
import type { Inventory } from "./inventory.js";

export const SUPPORT_OFF = "Device support is off. Ask the user to turn it on in the Device panel.";
export const ACCESS_OFF = "Agent device access is off. The user can turn it on in Settings, Devices; it applies to conversations started after that.";
const NOT_OPEN = "No device is open in this conversation. Call the device tool with action open first.";
const platformNames = { ios: "iOS", android: "Android" } as const;

/** What the `device` tool needs from the device service. */
export interface AgentToolHost {
  settings(): DeviceSettings;
  inventory(): Promise<Inventory>;
  platforms(): Promise<DevicePlatformSupport[]>;
  /** Boots through the hub without waiting for the stream to attach: agent-device waits for the boot itself. */
  boot(device: Device): Promise<void>;
  serial(deviceId: string): string | null;
  /** Starts the agent-device daemon when needed; the shim's path and the config file agents pass. */
  daemon(): Promise<{ command: string; config: string }>;
  screenshot(device: Device): Promise<Buffer>;
  shutdown(deviceId: string): Promise<void>;
  push(message: DevicePanelPush): void;
}

/** Which device an agent meant: by id, else by platform preferring a running one, else the only platform there is. */
export function pickDevice(devices: Device[], input: Pick<DeviceToolInput, "deviceId" | "platform">): Device {
  if (input.deviceId) {
    const match = devices.find((device) => device.id === input.deviceId);
    if (match) return match;
    throw new Error(`No device ${input.deviceId}. Call the device tool with action list for current ids.`);
  }
  const candidates = devices.filter((device) => !input.platform || device.platform === input.platform);
  if (!candidates.length) {
    throw new Error(
      input.platform
        ? `No ${platformNames[input.platform]} devices were found. Call the device tool with action list to see why.`
        : "No simulators or emulators were found. Call the device tool with action list to see why.",
    );
  }
  if (!input.platform && new Set(candidates.map((device) => device.platform)).size > 1) throw new Error("Both iOS and Android devices are available. Pass platform or deviceId.");
  return candidates.find((device) => device.state === "booted") ?? candidates.find((device) => device.state === "booting") ?? candidates[0]!;
}

/**
 * The `device` tool: list, open, screenshot and close. Driving happens through the agent-device CLI that `open`
 * returns. The devices each conversation opened are kept here, in memory, for its screenshots and closes.
 */
export class DeviceAgentTool {
  private readonly opened = new Map<string, string[]>();

  constructor(private readonly host: AgentToolHost) {}

  /** Throws the reason agents cannot use devices right now, if there is one. */
  assertAvailable(): void {
    const { enabled, agentAccess } = this.host.settings();
    if (!enabled) throw new Error(SUPPORT_OFF);
    if (!agentAccess) throw new Error(ACCESS_OFF);
  }

  forgetAll(): void {
    this.opened.clear();
  }

  async run(surface: string, input: DeviceToolInput): Promise<DeviceToolResult> {
    this.assertAvailable();
    switch (input.action) {
      case "list":
        return this.list(surface);
      case "open":
        return this.open(surface, input);
      case "screenshot":
        return this.screenshot(surface, input);
      case "close":
        return this.close(surface, input);
    }
  }

  private async list(surface: string): Promise<DeviceToolResult> {
    const [inventory, platforms] = await Promise.all([this.host.inventory(), this.host.platforms()]);
    return { action: "list", devices: inventory.devices, open: [...(this.opened.get(surface) ?? [])], platforms, warnings: inventory.warnings };
  }

  private async open(surface: string, input: DeviceToolInput): Promise<DeviceToolResult> {
    let device = pickDevice((await this.host.inventory()).devices, input);
    if (device.state === "shutdown" || device.state === "shutting-down") {
      await this.host.boot(device);
      device = (await this.host.inventory()).devices.find((item) => item.id === device.id) ?? { ...device, state: "booting" };
    }
    const target = device.platform === "ios" ? ["--platform", "ios", "--udid", device.id] : ["--platform", "android", "--serial", this.androidSerial(device)];
    const { command, config } = await this.host.daemon();
    this.remember(surface, device.id);
    this.host.push({ type: "device.panel", surface, deviceId: device.id, name: device.name, action: "open" });
    const args = [...target, "--config", config, "--session", sessionName(surface, device.id)];
    return { action: "open", device, command, args, howTo: howTo(device, command, args) };
  }

  private async screenshot(surface: string, input: DeviceToolInput): Promise<DeviceToolResult> {
    const id = this.openedDevice(surface, input.deviceId);
    const device = (await this.host.inventory()).devices.find((item) => item.id === id);
    if (!device) throw new Error(`Device ${id} is no longer available.`);
    const png = await this.host.screenshot(device);
    return { action: "screenshot", device, screenshot: { data: png.toString("base64"), mimeType: "image/png" } };
  }

  private async close(surface: string, input: DeviceToolInput): Promise<DeviceToolResult> {
    const id = this.openedDevice(surface, input.deviceId);
    this.opened.set(
      surface,
      (this.opened.get(surface) ?? []).filter((item) => item !== id),
    );
    const device = (await this.host.inventory()).devices.find((item) => item.id === id);
    this.host.push({ type: "device.panel", surface, deviceId: id, name: device?.name ?? id, action: "close" });
    const shutdown = input.shutdown === true;
    if (shutdown) await this.host.shutdown(id);
    return { action: "close", deviceId: id, shutdown };
  }

  private androidSerial(device: Device): string {
    const serial = this.host.serial(device.id);
    if (!serial) throw new Error(`${device.name} is still starting. Try again in a moment.`);
    return serial;
  }

  /** The device a screenshot or close means: the one named, else the one this conversation opened last. */
  private openedDevice(surface: string, deviceId: string | undefined): string {
    const opened = this.opened.get(surface) ?? [];
    const id = deviceId ?? opened.at(-1);
    if (!id) throw new Error(NOT_OPEN);
    if (!opened.includes(id)) throw new Error(`Device ${id} is not open in this conversation. Call the device tool with action open first.`);
    return id;
  }

  private remember(surface: string, deviceId: string): void {
    this.opened.set(surface, [...(this.opened.get(surface) ?? []).filter((item) => item !== deviceId), deviceId]);
  }
}
