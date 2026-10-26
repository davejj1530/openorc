import { existsSync } from "node:fs";
import path from "node:path";
import { settings as storedSettings, type Db } from "@openorc/db";
import {
  DEVICE_QUERY_KEYS,
  DeviceSettings,
  type Device,
  type DeviceHelpers,
  type DeviceList,
  type DevicePlatform,
  type DeviceStatus,
  type DeviceToolInput,
  type DeviceToolResult,
} from "@openorc/protocol";
import type { EnvSnapshot } from "../services/shell-environment.js";
import type { Logger, Transport } from "../transport.js";
import { AgentDeviceDaemon } from "./agent-device.js";
import { DeviceAgentTool } from "./agent-tool.js";
import { errorMessage, HubSupervisor } from "./hub.js";
import { bootOnHub, screenshotOnHub, shutdownOnHub, type HubRequest } from "./hub-api.js";
import { DeviceInventory, type Inventory } from "./inventory.js";
import { probePlatforms, toolEnvironment, type PlatformReport } from "./platforms.js";
import { attachRelay, DeviceTargetError, type MediaPort } from "./relay.js";
import { nodeSystem, type DeviceSystem } from "./system.js";
import { DeviceToolchain, pinnedVersion, resolveRuntime, type DeviceRuntime, type DeviceToolName, type RuntimeCheck } from "./toolchain.js";

const SETTINGS_KEY = "devices.settings";
const DEFAULT_SETTINGS: DeviceSettings = { enabled: false, agentAccess: true };
const PROBE_TTL_MS = 15_000;
const CHANGE_DEBOUNCE_MS = 300;
const QUITTING = "OpenOrc is quitting.";

/** A step of setup that overrides what the hub itself reports: an install, the agent daemon's start, or their failure. */
type SetupStep = Extract<DeviceHelpers, { phase: "installing" | "starting" | "failed" }>;

interface Probe {
  at: number;
  runtime: RuntimeCheck;
  report: PlatformReport;
}

export interface DeviceServiceOptions {
  db: Db;
  dataDir: string;
  /** The login shell's environment, for finding Node.js, Xcode and the Android SDK. */
  environment(): EnvSnapshot;
  transport: Transport;
  log: Logger;
  /** How processes run. Tests pass a fake. */
  system?: DeviceSystem;
  /** Where the hub's own output goes: the core's console, never a window. */
  debug?: (line: string) => void;
}

/**
 * iOS Simulators and Android Emulators: the supervised hub that boots and streams them, the agent-device daemon that
 * lets agents drive them, and the `device` tool. Turning support off stops both helpers; simulators and emulators
 * keep running, here and when the app quits.
 */
export class DeviceService {
  private readonly system: DeviceSystem;
  private readonly toolchain: DeviceToolchain;
  private readonly hub: HubSupervisor;
  private readonly daemon: AgentDeviceDaemon;
  private readonly inventory: DeviceInventory;
  private readonly agent: DeviceAgentTool;
  private step: SetupStep | null = null;
  private probed: Promise<Probe> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Boots and shutdowns in flight, shown over what simctl or adb report. */
  private readonly transitions = new Map<string, "booting" | "shutting-down">();
  private serials: ReadonlyMap<string, string> = new Map();
  private listed = "";
  private changePending = false;
  /** Set once the app quits: windows still open must not bring a helper back while the core shuts down. */
  private closed = false;
  private readonly request: HubRequest = (route, init) => this.hub.request(route, init);

  constructor(private readonly options: DeviceServiceOptions) {
    this.system = options.system ?? nodeSystem;
    const root = path.join(options.dataDir, "devices");
    const debug = options.debug ?? ((line: string) => console.debug(`[core:debug] device hub: ${line}`));
    this.toolchain = new DeviceToolchain(root, this.system);
    this.hub = new HubSupervisor({
      stateDir: path.join(root, "hub"),
      recordPath: path.join(root, "hub.json"),
      system: this.system,
      changed: () => this.invalidate(),
      devicesChanged: () => this.devicesChanged(),
      debug,
    });
    this.daemon = new AgentDeviceDaemon({ stateDir: path.join(root, "agent-device"), config: path.join(root, "agent-device", "config.json"), binDir: path.join(root, "bin") }, this.system);
    this.inventory = new DeviceInventory(this.system);
    this.agent = new DeviceAgentTool({
      settings: () => this.settings(),
      inventory: () => this.readInventory(),
      platforms: async () => (await this.probe()).report.platforms,
      boot: (device) => this.transition(device.id, "booting", () => this.bootOnHub(device)),
      serial: (id) => this.serials.get(id) ?? null,
      daemon: async () => {
        await this.ensureDaemon();
        return { command: this.daemon.shim, config: this.daemon.paths.config };
      },
      screenshot: async (device) => {
        await this.ensureHub();
        return screenshotOnHub(this.request, device, this.serials.get(device.id) ?? null);
      },
      shutdown: async (id) => {
        await this.shutdown(id);
      },
      push: (message) => options.transport.push(message),
    });
  }

  settings(): DeviceSettings {
    const raw = storedSettings.get(this.options.db, SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    try {
      return DeviceSettings.parse({ ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as object) });
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  async status(): Promise<DeviceStatus> {
    const [probe, tools] = await Promise.all([this.probe(), this.toolchain.status()]);
    return { settings: this.settings(), helpers: this.helpers(), platforms: probe.report.platforms, tools, blocked: probe.runtime.ok ? null : probe.runtime.blocked };
  }

  /** Turns support on: installs what is missing, starts the hub, and the agent daemon when agents have access. */
  setup(input: { agentAccess: boolean }): Promise<DeviceStatus> {
    return this.serial(() => this.bringUp(input.agentAccess));
  }

  setSettings(patch: Partial<DeviceSettings>): Promise<DeviceStatus> {
    return this.serial(async () => {
      const current = this.settings();
      const next = { ...current, ...patch };
      if (next.enabled && !current.enabled) return this.bringUp(next.agentAccess);
      this.writeSettings(next);
      if (current.enabled && !next.enabled) await this.stopHelpers();
      else if (next.enabled && current.agentAccess && !next.agentAccess) await this.daemon.stop();
      else if (next.enabled && next.agentAccess && !current.agentAccess) await this.grantAccess(current);
      return this.status();
    });
  }

  /** Works without the hub. While support is on, it also starts the hub in the background so live refresh works. */
  async list(): Promise<DeviceList> {
    const { devices, warnings } = await this.readInventory();
    this.listed = JSON.stringify({ devices, warnings });
    if (!this.closed && this.settings().enabled && this.hub.helpers().phase === "off" && !this.step) {
      this.ensureHub().catch((error: unknown) => this.options.log.warn(`device hub did not start: ${errorMessage(error)}`));
    }
    return { devices, warnings };
  }

  /** Boots a device and attaches its stream. A booted device only attaches. */
  async boot(deviceId: string): Promise<Device> {
    this.assertEnabled();
    const device = await this.find(deviceId);
    await this.transition(deviceId, "booting", async () => {
      if (device.state === "shutdown" || device.state === "shutting-down") await this.bootOnHub(device);
      if (device.platform === "ios") await this.hub.ensureAttached(device.id, true);
    });
    return this.find(deviceId);
  }

  async shutdown(deviceId: string): Promise<{ ok: true }> {
    this.assertEnabled();
    const device = await this.find(deviceId);
    await this.transition(deviceId, "shutting-down", async () => {
      await this.ensureHub();
      try {
        await shutdownOnHub(this.request, device, this.serials.get(device.id) ?? null);
      } catch (error) {
        // serve-sim runs simctl bare, so shutting down a simulator that is already off fails there.
        this.transitions.delete(deviceId);
        if ((await this.find(deviceId)).state !== "shutdown") throw error;
      }
      if (device.platform === "ios") this.hub.forgetAttached(device.id);
    });
    return { ok: true };
  }

  /** The `device` tool, for a conversation's `surface`. */
  runAgentTool(surface: string, input: DeviceToolInput): Promise<DeviceToolResult> {
    return this.agent.run(surface, input);
  }

  /** Throws why agents cannot use devices right now: support off, or agent access off. */
  assertAgentAccess(): void {
    this.agent.assertAvailable();
  }

  /** The environment a new run launches with: the agent-device shim first on PATH while agents have access. */
  launchEnvironment(snapshot: EnvSnapshot): EnvSnapshot {
    const { enabled, agentAccess } = this.settings();
    if (!enabled || !agentAccess || !existsSync(this.daemon.shim)) return snapshot;
    const PATH = [this.daemon.paths.binDir, snapshot.path].filter(Boolean).join(path.delimiter);
    return Object.freeze({ ...snapshot, path: PATH, env: Object.freeze({ ...snapshot.env, PATH }) });
  }

  /** Relays device streams to one window over its media port. */
  attachMedia(port: MediaPort): void {
    attachRelay(port, {
      target: (platform, deviceId) => this.target(platform, deviceId),
      request: (route, init) => this.hub.request(route, init),
      socket: (route) => this.hub.socket(route),
    });
  }

  /** At startup: helpers a crashed core left running, and the XCTest runners its daemon started, are stopped. */
  reapStale(): Promise<void> {
    return this.serial(async () => {
      await this.hub.reapStale().catch((error: unknown) => this.options.log.warn(`device hub cleanup failed: ${errorMessage(error)}`));
      await this.daemon.reapStale().catch((error: unknown) => this.options.log.warn(`agent-device cleanup failed: ${errorMessage(error)}`));
    });
  }

  /** Stops the helpers without waiting for queued work such as an install. Devices keep running. */
  async close(): Promise<void> {
    this.closed = true;
    await this.hub.stop();
    await this.daemon.stop();
  }

  private helpers(): DeviceHelpers {
    return this.step ?? this.hub.helpers();
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private setStep(step: SetupStep | null): void {
    this.step = step;
    this.invalidate();
  }

  private invalidate(): void {
    this.options.transport.push({ type: "invalidate", keys: [...DEVICE_QUERY_KEYS] });
  }

  private writeSettings(next: DeviceSettings): void {
    storedSettings.set(this.options.db, SETTINGS_KEY, JSON.stringify(DeviceSettings.parse(next)));
    this.invalidate();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(QUITTING);
  }

  private assertEnabled(): void {
    if (!this.settings().enabled) throw new Error("Turn on device support first.");
  }

  /** Runtime and platform checks, cached briefly: they run simctl and ffmpeg. */
  private probe(fresh = false): Promise<Probe> {
    const cached = this.probed;
    if (cached && !fresh) {
      return cached.then((probe) => (this.system.now() - probe.at < PROBE_TTL_MS ? probe : this.probe(true)));
    }
    const snapshot = this.options.environment();
    const probe = Promise.all([resolveRuntime(snapshot, this.system), probePlatforms(this.system, snapshot.env, snapshot.path)]).then(([runtime, report]) => ({
      at: this.system.now(),
      runtime,
      report,
    }));
    this.probed = probe;
    probe.catch(() => {
      if (this.probed === probe) this.probed = null;
    });
    return probe;
  }

  private async runtime(fresh = false): Promise<{ runtime: DeviceRuntime; probe: Probe }> {
    const probe = await this.probe(fresh);
    if (!probe.runtime.ok) throw new Error(probe.runtime.blocked);
    return { runtime: probe.runtime.runtime, probe };
  }

  /** Inside the queue. Settings say enabled only once everything is running, so a failed setup stays off. */
  private async bringUp(agentAccess: boolean): Promise<DeviceStatus> {
    this.setStep(null);
    try {
      const { runtime, probe } = await this.runtime(true);
      const hubEntry = await this.install("expo-device-hub", runtime);
      const agentEntry = agentAccess ? await this.install("agent-device", runtime) : null;
      this.setStep({ phase: "starting" });
      const env = toolEnvironment(runtime.env, probe.report.sdk);
      await this.hub.start({ node: runtime.node, entry: hubEntry, env });
      if (agentEntry) await this.daemon.ensure({ node: runtime.node, entry: agentEntry, env });
      else await this.daemon.stop();
    } catch (error) {
      await this.stopHelpers();
      this.writeSettings({ ...this.settings(), enabled: false });
      this.setStep({ phase: "failed", error: errorMessage(error) });
      throw error;
    }
    this.setStep(null);
    this.writeSettings({ enabled: true, agentAccess });
    return this.status();
  }

  /** Inside the queue. A failed start leaves agent access off, so the switch shows what is true. */
  private async grantAccess(previous: DeviceSettings): Promise<void> {
    try {
      await this.startDaemon();
    } catch (error) {
      this.writeSettings(previous);
      throw error;
    }
  }

  private async install(name: DeviceToolName, runtime: DeviceRuntime): Promise<string> {
    if ((await this.toolchain.installed(name)) === pinnedVersion(name)) return this.toolchain.entry(name);
    this.setStep({ phase: "installing", detail: `Installing ${name} ${pinnedVersion(name)}` });
    try {
      return await this.toolchain.ensureInstalled(name, runtime);
    } finally {
      this.setStep(null);
    }
  }

  private async stopHelpers(): Promise<void> {
    this.agent.forgetAll();
    await this.hub.stop();
    await this.daemon.stop();
    this.setStep(null);
  }

  /** Starts the hub when support is on and it is not running, installing it first if it went missing. */
  private async ensureHub(): Promise<void> {
    if (this.hub.running) return;
    this.assertOpen();
    this.assertEnabled();
    await this.serial(async () => {
      this.assertOpen();
      if (this.hub.running || !this.settings().enabled) return;
      this.setStep(null);
      try {
        const { runtime, probe } = await this.runtime();
        const entry = await this.install("expo-device-hub", runtime);
        await this.hub.start({ node: runtime.node, entry, env: toolEnvironment(runtime.env, probe.report.sdk) });
      } catch (error) {
        this.setStep({ phase: "failed", error: errorMessage(error) });
        throw error;
      }
    });
  }

  private ensureDaemon(): Promise<void> {
    return this.serial(async () => {
      this.assertOpen();
      this.agent.assertAvailable();
      await this.startDaemon();
    });
  }

  private async startDaemon(): Promise<void> {
    const { runtime, probe } = await this.runtime();
    const entry = await this.install("agent-device", runtime);
    await this.daemon.ensure({ node: runtime.node, entry, env: toolEnvironment(runtime.env, probe.report.sdk) });
  }

  private async bootOnHub(device: Device): Promise<void> {
    await this.ensureHub();
    const { serial } = await bootOnHub(this.request, device);
    if (serial) this.serials = new Map([...this.serials, [device.id, serial]]);
  }

  /** Shows `state` over the device while `operation` runs. */
  private async transition(deviceId: string, state: "booting" | "shutting-down", operation: () => Promise<void>): Promise<void> {
    this.transitions.set(deviceId, state);
    this.invalidate();
    try {
      await operation();
    } finally {
      this.transitions.delete(deviceId);
      this.invalidate();
    }
  }

  private async readInventory(): Promise<Inventory> {
    const { report } = await this.probe();
    const ios = report.platforms.some((platform) => platform.platform === "ios" && platform.available);
    const inventory = await this.inventory.read({ ios, sdk: report.sdk, env: this.options.environment().env });
    this.serials = inventory.serials;
    for (const device of inventory.devices) if (device.platform === "ios" && device.state !== "booted") this.hub.forgetAttached(device.id);
    const devices = inventory.devices.map((device) => {
      const state = this.transitions.get(device.id);
      return state ? { ...device, state } : device;
    });
    return { ...inventory, devices };
  }

  private async find(deviceId: string): Promise<Device> {
    const device = (await this.readInventory()).devices.find((item) => item.id === deviceId);
    if (!device) throw new Error("That device is no longer available.");
    return device;
  }

  /** The hub said the device list changed: list again, and tell windows only when what they would see changed. */
  private devicesChanged(): void {
    if (this.changePending) return;
    this.changePending = true;
    void this.system
      .delay(CHANGE_DEBOUNCE_MS)
      .then(async () => {
        this.changePending = false;
        const { devices, warnings } = await this.readInventory();
        const listed = JSON.stringify({ devices, warnings });
        if (listed === this.listed) return;
        this.listed = listed;
        this.invalidate();
      })
      .catch((error: unknown) => this.options.log.warn(`device list refresh failed: ${errorMessage(error)}`));
  }

  /** What a window's stream channel connects to. Its reasons are the core's own words, safe to show. */
  private async target(platform: DevicePlatform, deviceId: string): Promise<string> {
    if (this.closed) throw new DeviceTargetError(QUITTING);
    if (!this.settings().enabled) throw new DeviceTargetError("Device support is off.");
    await this.ensureHub();
    if (platform === "android") {
      const serial = this.serials.get(deviceId) ?? (await this.readInventory()).serials.get(deviceId);
      if (!serial) throw new DeviceTargetError("This emulator is not running.");
      return serial;
    }
    if (!this.hub.isAttached(deviceId)) {
      const state = (await this.find(deviceId).catch(() => null))?.state;
      // Attaching waits for a boot, so a window reconnecting to a simulator someone shut down must not attach it.
      if (state !== "booted" && state !== "booting") throw new DeviceTargetError("This simulator is not running.");
    }
    await this.hub.ensureAttached(deviceId).catch(() => {
      throw new DeviceTargetError("The simulator's screen could not be attached.");
    });
    return deviceId;
  }
}
