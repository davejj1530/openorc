import { readFile, stat, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "@openorc/db";
import type { Broadcast } from "../transport.js";
import { DeviceMachine } from "./fixtures/device-machine.js";
import { FakePort } from "./fixtures/fake-port.js";
import { until } from "./fixtures/wait.js";
import { DeviceService } from "./service.js";

let dir: string;
let machine: DeviceMachine;
let db: Db;
let pushes: Broadcast[];
let service: DeviceService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openorc-devices-test-"));
  machine = await new DeviceMachine(dir).setup();
  db = Db.memory();
  pushes = [];
  service = new DeviceService({
    db,
    dataDir: path.join(dir, "data"),
    environment: () => machine.snapshot(),
    transport: { push: (message) => pushes.push(message) },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    system: machine.system,
    debug: () => undefined,
  });
});

afterEach(async () => {
  await service.close();
  await machine.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const devicesDir = () => path.join(dir, "data", "devices");
const hub = () => machine.system.hubs.at(-1)!.hub;
const invalidations = () => pushes.filter((push) => push.type === "invalidate").length;

describe("setup", () => {
  it("installs both pinned tools, starts the hub and the agent daemon, then turns support on", async () => {
    const seen: unknown[] = [];
    machine.duringInstall = async () => {
      const status = await service.status();
      seen.push({ enabled: status.settings.enabled, helpers: status.helpers });
    };
    const status = await service.setup({ agentAccess: true });

    expect(machine.installs).toEqual(["expo-device-hub", "agent-device"]);
    expect(seen).toEqual([
      { enabled: false, helpers: { phase: "installing", detail: "Installing expo-device-hub 0.18.0" } },
      { enabled: false, helpers: { phase: "installing", detail: "Installing agent-device 0.21.31" } },
    ]);
    expect(status).toMatchObject({
      settings: { enabled: true, agentAccess: true },
      helpers: { phase: "running" },
      blocked: null,
      tools: [
        { name: "expo-device-hub", pinned: "0.18.0", installed: "0.18.0" },
        { name: "agent-device", pinned: "0.21.31", installed: "0.21.31" },
      ],
    });
    expect(status.platforms).toEqual([
      { platform: "ios", available: true, reason: null },
      { platform: "android", available: false, reason: "Android needs the SDK platform-tools, emulator and cmdline-tools/latest." },
    ]);
    const config = path.join(devicesDir(), "agent-device", "config.json");
    expect(JSON.parse(await readFile(config, "utf8"))).toMatchObject({ daemonAuthToken: machine.daemonToken });
    expect((await stat(config)).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(devicesDir(), "bin", "agent-device"))).mode & 0o777).toBe(0o755);

    await service.setup({ agentAccess: true });
    expect(machine.installs).toHaveLength(2);
    expect(machine.system.hubs).toHaveLength(1);
  });

  it("stays off and reports why when an install fails", async () => {
    machine.npmExit = 1;
    await expect(service.setup({ agentAccess: true })).rejects.toThrow("Installing expo-device-hub failed: npm exited with code 1.");
    const status = await service.status();
    expect(status.settings.enabled).toBe(false);
    expect(status.helpers).toEqual({ phase: "failed", error: "Installing expo-device-hub failed: npm exited with code 1." });
    expect(machine.system.hubs).toHaveLength(0);
  });

  it("refuses to start on a Node.js older than 22.12", async () => {
    machine.nodeVersion = "v22.11.0";
    await expect(service.setup({ agentAccess: false })).rejects.toThrow("Device support needs Node.js 22.12 or later.");
    expect((await service.status()).blocked).toBe("Device support needs Node.js 22.12 or later.");
    expect(machine.installs).toEqual([]);
  });

  it("installs agent-device only when agents have access", async () => {
    await service.setup({ agentAccess: false });
    expect(machine.installs).toEqual(["expo-device-hub"]);
    await expect(stat(path.join(devicesDir(), "agent-device", "config.json"))).rejects.toThrow();
  });
});

describe("devices", () => {
  beforeEach(async () => {
    await service.setup({ agentAccess: true });
  });

  it("lists simulators from simctl, including ones the hub has never booted", async () => {
    const list = await service.list();
    expect(list).toEqual({
      devices: [
        { id: "IPHONE-17", platform: "ios", name: "iPhone 17 Pro", os: "iOS 26.5", formFactor: "phone", state: "shutdown" },
        { id: "IPAD-AIR", platform: "ios", name: "iPad Air", os: "iOS 26.5", formFactor: "tablet", state: "booted" },
      ],
      warnings: [],
    });
  });

  it("shows a booting device as booting until its stream is attached", async () => {
    const server = await hub();
    server.replies.set("POST /api/devices/boot", () => {
      machine.simulators[0]!.state = "Booted";
      return { json: { ok: true } };
    });
    server.replies.set("POST /vendor/serve-sim/grid/api/start", { json: { ok: true }, delayMs: 150 });
    const booting = service.boot("IPHONE-17");
    await until(() => server.calls.some((call) => call.path === "/vendor/serve-sim/grid/api/start"));
    expect((await service.list()).devices.find((device) => device.id === "IPHONE-17")?.state).toBe("booting");

    expect(await booting).toMatchObject({ id: "IPHONE-17", state: "booted" });
    expect(server.calls.filter((call) => call.method === "POST").map(({ path, body }) => ({ path, body }))).toEqual([
      { path: "/api/devices/boot", body: { platform: "ios", id: "IPHONE-17", name: "iPhone 17 Pro" } },
      { path: "/vendor/serve-sim/grid/api/start", body: { udid: "IPHONE-17" } },
    ]);
  });

  it("only attaches a device that is already booted", async () => {
    await service.boot("IPAD-AIR");
    const server = await hub();
    expect(server.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/vendor/serve-sim/grid/api/start"]);
  });

  it("shuts a simulator down through serve-sim, and an already-off one is not an error", async () => {
    const server = await hub();
    await service.shutdown("IPAD-AIR");
    expect(server.calls.at(-1)).toMatchObject({ path: "/vendor/serve-sim/grid/api/shutdown", body: { udid: "IPAD-AIR" } });
    server.replies.set("POST /vendor/serve-sim/grid/api/shutdown", { json: { ok: false, errors: [{ message: "Unable to shutdown device in current state: Shutdown" }] } });
    await expect(service.shutdown("IPHONE-17")).resolves.toEqual({ ok: true });
    machine.simulators[1]!.state = "Booted";
    await expect(service.shutdown("IPAD-AIR")).rejects.toThrow("Unable to shutdown device in current state: Shutdown");
  });

  it("refreshes the list on hub change messages, and tells windows only when it changed", async () => {
    await service.list();
    const server = await hub();
    await until(() => server.sockets.some((socket) => socket.path === "/api/devices/ws"));
    const before = invalidations();
    const listings = () => machine.system.runs.filter((call) => call.args.join(" ") === "simctl list devices available -j").length;
    const listed = listings();
    server.signal({ type: "device-list" });
    await until(() => listings() > listed);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invalidations()).toBe(before);

    machine.simulators[0]!.state = "Booted";
    server.signal({ type: "device-list" });
    await until(() => invalidations() > before);
    expect((await service.list()).devices.find((device) => device.id === "IPHONE-17")?.state).toBe("booted");
  });

  it("streams a running simulator to a window, and never attaches one that is shut down", async () => {
    const port = new FakePort();
    service.attachMedia(port);
    port.send({ type: "open", channel: 1, kind: "ios-video", deviceId: "IPAD-AIR" });
    port.send({ type: "open", channel: 2, kind: "ios-video", deviceId: "IPHONE-17" });
    await until(() => [1, 2].every((channel) => port.of(channel).some((event) => event.type === "closed")));

    expect(port.of(1)[0]).toEqual({ type: "opened", channel: 1, contentType: "video/avcc" });
    expect(port.of(2)).toEqual([{ type: "closed", channel: 2, reason: "This simulator is not running." }]);
    const server = await hub();
    expect(server.calls.filter((call) => call.path.includes("grid/api/start")).map((call) => call.body)).toEqual([{ udid: "IPAD-AIR" }]);
    expect(JSON.stringify(port.events.filter((event) => event.type !== "data"))).not.toContain(server.token);
    port.close();
  });

  it("turning support off stops the hub and the daemon, and leaves every device running", async () => {
    const hubPid = machine.system.hubs[0]!.pid;
    await service.setSettings({ enabled: false });
    expect(machine.system.alive(hubPid)).toBe(false);
    expect(machine.system.runs.some((call) => call.args[1] === "daemon" && call.args[2] === "stop")).toBe(true);
    await expect(stat(path.join(devicesDir(), "agent-device", "config.json"))).rejects.toThrow();
    const server = await hub();
    expect(server.calls.filter((call) => call.path.includes("shutdown"))).toEqual([]);
    expect(machine.simctlWrites()).toEqual([]);
    expect((await service.status()).helpers).toEqual({ phase: "off" });
    await expect(service.boot("IPHONE-17")).rejects.toThrow("Turn on device support first.");
  });

  it("quitting stops the helpers and shuts no device down", async () => {
    await service.close();
    const server = await hub();
    expect(server.calls.filter((call) => call.path.includes("shutdown"))).toEqual([]);
    expect(machine.simctlWrites()).toEqual([]);
    expect(machine.system.alive(machine.system.hubs[0]!.pid)).toBe(false);
  });

  it("starts no hub for a window that reconnects while OpenOrc quits", async () => {
    const port = new FakePort();
    service.attachMedia(port);
    const closing = service.close();
    port.send({ type: "open", channel: 1, kind: "ios-video", deviceId: "IPAD-AIR" });
    await closing;
    await service.list();
    port.send({ type: "open", channel: 2, kind: "ios-video", deviceId: "IPAD-AIR" });
    await until(() => [1, 2].every((channel) => port.of(channel).some((event) => event.type === "closed")));

    expect(machine.system.hubs).toHaveLength(1);
    expect(machine.system.alive(machine.system.hubs[0]!.pid)).toBe(false);
    expect(port.of(2)).toEqual([{ type: "closed", channel: 2, reason: "OpenOrc is quitting." }]);
  });
});

describe("agent access and the launch environment", () => {
  it("puts the agent-device shim first on PATH only while support and agent access are on", async () => {
    const snapshot = machine.snapshot();
    expect(service.launchEnvironment(snapshot)).toBe(snapshot);

    await service.setup({ agentAccess: true });
    const bin = path.join(devicesDir(), "bin");
    const launched = service.launchEnvironment(snapshot);
    expect(launched.path).toBe(`${bin}${path.delimiter}${machine.bin}`);
    expect(launched.env["PATH"]).toBe(launched.path);
    expect(Object.isFrozen(launched.env)).toBe(true);

    await service.setSettings({ agentAccess: false });
    expect(service.launchEnvironment(snapshot)).toBe(snapshot);
    await expect(stat(path.join(devicesDir(), "agent-device", "config.json"))).rejects.toThrow();

    await service.setSettings({ agentAccess: true });
    expect(service.launchEnvironment(snapshot).path.startsWith(bin)).toBe(true);
    expect(JSON.parse(await readFile(path.join(devicesDir(), "agent-device", "config.json"), "utf8"))).toMatchObject({ daemonAuthToken: machine.daemonToken });
  });
});

describe("startup", () => {
  it("stops a hub and the XCTest runners a crashed core left behind", async () => {
    const entry = path.join(devicesDir(), "tools", "expo-device-hub", "0.18.0", "node_modules", "expo-device-hub", "dist", "server", "cli.mjs");
    const staleHub = machine.system.process(`node ${entry} --port 50000`);
    const staleDaemon = machine.system.process("node /data/devices/tools/agent-device/0.21.31/node_modules/agent-device/dist/daemon.js");
    const runner = machine.system.process(`xcodebuild test-without-building -xctestrun /tmp/AgentDeviceRunner-owner-${staleDaemon}-1.xctestrun`);
    const otherRunner = machine.system.process("xcodebuild test-without-building -xctestrun /tmp/AgentDeviceRunner-owner-1-1.xctestrun");
    await mkdir(path.join(devicesDir(), "agent-device"), { recursive: true });
    await writeFile(path.join(devicesDir(), "hub.json"), JSON.stringify({ pid: staleHub, port: 50000, entryPath: entry }));
    await writeFile(path.join(devicesDir(), "agent-device", "daemon.json"), JSON.stringify({ httpPort: 1, token: "old", pid: staleDaemon }));

    await service.reapStale();
    expect(machine.system.signals.map((signal) => signal.pid).sort()).toEqual([staleHub, staleDaemon, runner].sort());
    expect(machine.system.alive(otherRunner)).toBe(true);
  });
});
