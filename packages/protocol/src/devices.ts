import { z } from "zod";

export const DevicePlatform = z.enum(["ios", "android"]);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

/**
 * iOS: the simulator's UDID. Android: the AVD name, which stays the same across boots; the emulator serial a booted
 * AVD gets is the core's business.
 */
export const DeviceId = z.string().min(1).max(200);

export type DeviceState = "shutdown" | "booting" | "booted" | "shutting-down";

export interface Device {
  id: string;
  platform: DevicePlatform;
  name: string;
  /** "iOS 26.5", "Android API 36". The picker groups by it, newest first. */
  os: string;
  formFactor: "phone" | "tablet";
  state: DeviceState;
}

export interface DeviceList {
  devices: Device[];
  /** Discovery problems that left the list incomplete, in a sentence each. */
  warnings: string[];
}

/** Whether this machine can run a platform's devices. `reason` is short and names only what blocks it. */
export interface DevicePlatformSupport {
  platform: DevicePlatform;
  available: boolean;
  reason: string | null;
  /** Android only: emulator video needs ffmpeg with libx264. A device still boots and agents can drive it without it. */
  video?: { available: boolean; reason: string | null };
}

export const DeviceSettings = z.object({
  /** Device support. Off stops the hub and the agent daemon; simulators and emulators keep running. */
  enabled: z.boolean(),
  /** Agents can use devices: a `device` tool that opens them and an `agent-device` command on new runs' PATH. */
  agentAccess: z.boolean(),
});
export type DeviceSettings = z.infer<typeof DeviceSettings>;

/** The helpers OpenOrc supervises: the device hub, and the agent-device daemon while agents have access. */
export type DeviceHelpers =
  { phase: "off" } | { phase: "installing"; detail: string } | { phase: "starting" } | { phase: "running" } | { phase: "restarting"; error: string } | { phase: "failed"; error: string };

export interface DeviceTool {
  name: "expo-device-hub" | "agent-device";
  /** The version OpenOrc installs. */
  pinned: string;
  /** What is installed in OpenOrc's data folder, or null. */
  installed: string | null;
}

export interface DeviceStatus {
  settings: DeviceSettings;
  helpers: DeviceHelpers;
  platforms: DevicePlatformSupport[];
  tools: DeviceTool[];
  /** Why the tools cannot be installed or started on this machine at all, such as no Node.js 22.12 or npm. */
  blocked: string | null;
}

export const devicePanelRpcParams = {
  "devices.status": z.object({}),
  /** Turns device support on: installs the pinned tools when missing, then starts the helpers. Resolves when running. */
  "devices.setup": z.object({ agentAccess: z.boolean() }),
  "devices.settings.set": DeviceSettings.partial(),
  "devices.list": z.object({}),
  /** Boots a device and attaches its stream. A booted device only attaches. */
  "devices.boot": z.object({ deviceId: DeviceId }),
  "devices.shutdown": z.object({ deviceId: DeviceId }),
};
export interface DevicePanelRpcResults {
  "devices.status": DeviceStatus;
  "devices.setup": DeviceStatus;
  "devices.settings.set": DeviceStatus;
  "devices.list": DeviceList;
  "devices.boot": Device;
  "devices.shutdown": { ok: true };
}

/** Query keys the core invalidates when device state changes. */
export const DEVICE_QUERY_KEYS = ["devices"] as const;

/**
 * An agent opened or closed a device in a conversation's panel. Every window hears it; a window shows or drops the
 * device's tab in that conversation's panel.
 */
export const DevicePanelPush = z.object({
  type: z.literal("device.panel"),
  surface: z.string(),
  deviceId: DeviceId,
  name: z.string(),
  action: z.enum(["open", "close"]),
});
export type DevicePanelPush = z.infer<typeof DevicePanelPush>;

/**
 * The media relay. Each window gets a second MessagePort beside its RPC port, and the core relays one device stream per
 * channel over it. A window names what it wants by kind and device, never by hub path: the core maps each kind to one
 * hub route and holds the hub's address and token itself.
 *
 * - `ios-video`: the AVCC body of an iOS simulator's H.264 stream, as byte chunks.
 * - `ios-mjpeg`: its multipart MJPEG body, as byte chunks. `opened.contentType` carries the boundary.
 * - `ios-control`: the iOS helper's binary WebSocket: screen config in, touches, buttons, keys and orientation out.
 * - `android`: the emulator's WebSocket: SEMU-framed H.264 and JSON events in, JSON gestures and keys out.
 */
export const DeviceChannelKind = z.enum(["ios-video", "ios-mjpeg", "ios-control", "android"]);
export type DeviceChannelKind = z.infer<typeof DeviceChannelKind>;

/** Renderer to core. Channel numbers are the window's own; the core keys them by port. */
export type DeviceRelayRequest =
  { type: "open"; channel: number; kind: DeviceChannelKind; deviceId: string } | { type: "send"; channel: number; data: ArrayBuffer | string } | { type: "close"; channel: number };

/**
 * Core to renderer. `data` carries a body chunk or one WebSocket message. `at` is when the core read it, as
 * `performance.timeOrigin + performance.now()`, so a window can measure the relay's own delay.
 */
export type DeviceRelayEvent =
  | { type: "opened"; channel: number; contentType?: string }
  | { type: "data"; channel: number; data: ArrayBuffer | string; at: number }
  | { type: "closed"; channel: number; status?: number; reason?: string };

/** The `device` tool's input. Flat, because some providers drop tools whose schema is a union. */
export const DeviceToolInput = z
  .object({
    action: z.enum(["list", "open", "screenshot", "close"]),
    deviceId: DeviceId.optional(),
    platform: DevicePlatform.optional(),
    shutdown: z.boolean().optional(),
  })
  .strict();
export type DeviceToolInput = z.infer<typeof DeviceToolInput>;

export type DeviceToolResult =
  | { action: "list"; devices: Device[]; open: string[]; platforms: DevicePlatformSupport[]; warnings: string[] }
  | { action: "open"; device: Device; command: string; args: string[]; howTo: string }
  | { action: "screenshot"; device: Device; screenshot: { data: string; mimeType: "image/png" } }
  | { action: "close"; deviceId: string; shutdown: boolean };
