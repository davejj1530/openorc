import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeviceHelpers } from "@openorc/protocol";
import { FakeSystem } from "./fixtures/fake-system.js";
import { until } from "./fixtures/wait.js";
import { HubSupervisor, nextBackoff } from "./hub.js";

const launch = { node: "/usr/local/bin/node", entry: "/data/devices/tools/expo-device-hub/0.18.0/node_modules/expo-device-hub/dist/server/cli.mjs", env: { PATH: "/usr/bin" } };

let dir: string;
let system: FakeSystem;
let supervisor: HubSupervisor;
let deviceSignals: number;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openorc-hub-test-"));
  system = new FakeSystem(dir);
  deviceSignals = 0;
  supervisor = new HubSupervisor({
    stateDir: path.join(dir, "hub"),
    recordPath: path.join(dir, "hub.json"),
    system,
    changed: () => undefined,
    devicesChanged: () => deviceSignals++,
    debug: () => undefined,
  });
});

afterEach(async () => {
  await supervisor.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("HubSupervisor", () => {
  it("starts the hub on loopback behind a token, and adds the token to every request it makes", async () => {
    await supervisor.start(launch);
    const spawned = system.hubs[0]!;
    expect(spawned.args).toEqual([launch.entry, "--port", String(spawned.port), "--host", "127.0.0.1", "--require-token", "--hide-sidebar", "--hide-boot-device"]);
    expect(spawned.env).toMatchObject({ PATH: "/usr/bin", EXPO_DEVICE_HUB_STATE_DIR: path.join(dir, "hub"), NO_COLOR: "1" });
    expect(supervisor.helpers()).toEqual({ phase: "running" });

    const response = await supervisor.request("/api/devices/shutdown", { method: "POST", body: JSON.stringify({ platform: "ios", id: "A" }) });
    expect(response.status).toBe(200);
    const hub = await spawned.hub;
    expect(hub.calls.at(-1)).toEqual({ method: "POST", path: "/api/devices/shutdown", body: { platform: "ios", id: "A" }, authorized: true });
    // Our record of the hub never holds its token.
    expect(JSON.parse(await readFile(path.join(dir, "hub.json"), "utf8"))).toEqual({ pid: spawned.pid, port: spawned.port, entryPath: launch.entry });
  });

  it("logs the hub's output without its token", async () => {
    const lines: string[] = [];
    const logged = new HubSupervisor({
      stateDir: path.join(dir, "logged"),
      recordPath: path.join(dir, "logged.json"),
      system,
      changed: () => undefined,
      devicesChanged: () => undefined,
      debug: (line) => lines.push(line),
    });
    await logged.start(launch);
    const { token } = await system.hubs[0]!.hub;
    await logged.stop();
    expect(lines.some((line) => line.includes("Local:"))).toBe(true);
    expect(lines.join("\n")).not.toContain(token);
  });

  it("asks Android-only hosts for Android devices only", async () => {
    system.platform = "linux";
    await supervisor.start(launch);
    expect(system.hubs[0]!.args.slice(-2)).toEqual(["--platform", "android"]);
  });

  it("restarts a hub that exits on its own, waiting 1 s, then 2 s, 4 s, and 1 s again after a stable minute", async () => {
    const waits: (DeviceHelpers & { ms: number })[] = [];
    system.onDelay = (ms) => {
      if (ms >= 1000 && supervisor.helpers().phase === "restarting") waits.push({ ...supervisor.helpers(), ms });
    };
    await supervisor.start(launch);
    const crashAndRecover = async () => {
      const count = system.hubs.length;
      await system.hubs.at(-1)!.crash(1);
      await until(() => system.hubs.length === count + 1 && supervisor.helpers().phase === "running");
    };
    await crashAndRecover();
    await crashAndRecover();
    await crashAndRecover();
    system.clock += 60_000;
    await crashAndRecover();
    expect(waits).toEqual([1000, 2000, 4000, 1000].map((ms) => ({ phase: "restarting", error: "The device hub exited with code 1.", ms })));

    const latest = await system.hubs.at(-1)!.hub;
    await supervisor.request("/api/devices/shutdown", { method: "POST", body: "{}" });
    expect(latest.calls.at(-1)?.authorized).toBe(true);
  });

  it("does not restart a hub it stopped, and stopping twice is harmless", async () => {
    await supervisor.start(launch);
    await supervisor.stop();
    await supervisor.stop();
    expect(system.hubs).toHaveLength(1);
    expect(system.alive(system.hubs[0]!.pid)).toBe(false);
    expect(supervisor.helpers()).toEqual({ phase: "off" });
    await expect(readFile(path.join(dir, "hub.json"))).rejects.toThrow();
    await expect(supervisor.request("/api/devices", {})).rejects.toThrow("The device hub is not running.");
  });

  it("reaps a hub a crashed core left behind, but never a process that reused its pid", async () => {
    const stale = system.process(`node ${launch.entry} --port 51000`);
    await writeFile(path.join(dir, "hub.json"), JSON.stringify({ pid: stale, port: 51000, entryPath: launch.entry }));
    await supervisor.reapStale();
    expect(system.signals).toEqual([{ pid: stale, signal: "SIGTERM" }]);
    await expect(readFile(path.join(dir, "hub.json"))).rejects.toThrow();

    const stranger = system.process("/usr/bin/vim notes.txt");
    await writeFile(path.join(dir, "hub.json"), JSON.stringify({ pid: stranger, port: 51000, entryPath: launch.entry }));
    await supervisor.reapStale();
    expect(system.signals).toHaveLength(1);
    expect(system.alive(stranger)).toBe(true);
  });

  it("treats every device list message as a change and ignores heartbeats", async () => {
    await supervisor.start(launch);
    const hub = await system.hubs[0]!.hub;
    await until(() => hub.sockets.some((socket) => socket.path === "/api/devices/ws"));
    expect(hub.calls.find((call) => call.method === "WS")).toMatchObject({ path: "/api/devices/ws", authorized: true });
    hub.signal({ type: "heartbeat" });
    hub.signal({ type: "device-list", devices: [] });
    await until(() => deviceSignals > 0);
    expect(deviceSignals).toBe(1);
  });

  it("attaches a simulator's stream once per hub instance unless asked for a fresh attach", async () => {
    await supervisor.start(launch);
    await supervisor.ensureAttached("UDID-1");
    await supervisor.ensureAttached("UDID-1");
    const hub = await system.hubs[0]!.hub;
    const attaches = () => hub.calls.filter((call) => call.path === "/vendor/serve-sim/grid/api/start");
    expect(attaches()).toEqual([{ method: "POST", path: "/vendor/serve-sim/grid/api/start", body: { udid: "UDID-1" }, authorized: true }]);
    await supervisor.ensureAttached("UDID-1", true);
    expect(attaches()).toHaveLength(2);
  });
});

describe("nextBackoff", () => {
  it("doubles up to 30 s and starts over after a minute of uptime", () => {
    const delays: number[] = [];
    let delay = 0;
    for (let i = 0; i < 7; i++) delays.push((delay = nextBackoff(delay, 5_000)));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(nextBackoff(30_000, 60_000)).toBe(1000);
  });
});
