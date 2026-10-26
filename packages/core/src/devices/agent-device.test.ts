import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentDeviceDaemon, sessionName } from "./agent-device.js";
import { DeviceMachine } from "./fixtures/device-machine.js";

let dir: string;
let machine: DeviceMachine;
let daemon: AgentDeviceDaemon;
let entry: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openorc-agent-device-test-"));
  machine = await new DeviceMachine(dir).setup();
  daemon = new AgentDeviceDaemon(
    { stateDir: path.join(dir, "devices", "agent-device"), config: path.join(dir, "devices", "agent-device", "config.json"), binDir: path.join(dir, "devices", "bin") },
    machine.system,
  );
  // Stands in for agent-device's CLI: prints what it was run with.
  entry = path.join(dir, "fake-agent-device.mjs");
  await writeFile(
    entry,
    "console.log(JSON.stringify({ args: process.argv.slice(2), baseUrl: process.env.AGENT_DEVICE_DAEMON_BASE_URL ?? null, token: process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN ?? null }));\n",
  );
});

afterEach(async () => {
  await machine.close();
  await rm(dir, { recursive: true, force: true });
});

const launch = () => ({ node: process.execPath, entry, env: { PATH: machine.bin } });

async function runShim(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { PATH: "/usr/bin:/bin", AGENT_DEVICE_DAEMON_BASE_URL: "http://elsewhere", AGENT_DEVICE_DAEMON_AUTH_TOKEN: "stolen" };
  try {
    const { stdout, stderr } = await promisify(execFile)(daemon.shim, args, { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

describe("agent-device daemon", () => {
  it("starts the daemon in HTTP mode and writes a private config with its endpoint", async () => {
    await daemon.ensure(launch());
    const start = machine.system.runs.find((call) => call.args[1] === "devices")!;
    expect(start.args).toEqual([entry, "devices", "--json"]);
    expect(start.env).toMatchObject({ AGENT_DEVICE_STATE_DIR: daemon.paths.stateDir, AGENT_DEVICE_DAEMON_SERVER_MODE: "http", AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0" });
    expect(JSON.parse(await readFile(daemon.paths.config, "utf8"))).toEqual({ daemonBaseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), daemonAuthToken: machine.daemonToken });
    expect((await stat(daemon.paths.config)).mode & 0o777).toBe(0o600);

    await daemon.ensure(launch());
    expect(machine.system.runs.filter((call) => call.args[1] === "devices")).toHaveLength(1);
  });

  it("reuses a healthy daemon it finds instead of starting another", async () => {
    await mkdir(daemon.paths.stateDir, { recursive: true });
    await daemon.ensure(launch());
    const fresh = new AgentDeviceDaemon(daemon.paths, machine.system);
    await fresh.ensure(launch());
    expect(machine.system.runs.filter((call) => call.args[1] === "devices")).toHaveLength(1);
  });

  it("stops the daemon and only the XCTest runners it owns, and deletes the config", async () => {
    await daemon.ensure(launch());
    const owner = machine.daemonPid!;
    const owned = machine.system.process(`xcodebuild test-without-building -xctestrun /tmp/AgentDeviceRunner-owner-${owner}-ab.xctestrun`);
    const foreign = machine.system.process(`xcodebuild test-without-building -xctestrun /tmp/AgentDeviceRunner-owner-${owner + 1}-ab.xctestrun`);
    const unrelated = machine.system.process(`node build.mjs -owner-${owner}-`);

    await daemon.stop();
    expect(machine.system.runs.find((call) => call.args[1] === "daemon")?.args).toEqual([entry, "daemon", "stop", "--state-dir", daemon.paths.stateDir]);
    expect(machine.system.alive(owned)).toBe(false);
    expect(machine.system.alive(foreign)).toBe(true);
    expect(machine.system.alive(unrelated)).toBe(true);
    await expect(stat(daemon.paths.config)).rejects.toThrow();
  });

  it("names a session per conversation and device", () => {
    expect(sessionName("thread:a", "UDID")).toMatch(/^openorc-[0-9a-f]{16}$/);
    expect(sessionName("thread:a", "UDID")).toBe(sessionName("thread:a", "UDID"));
    expect(sessionName("thread:b", "UDID")).not.toBe(sessionName("thread:a", "UDID"));
  });
});

describe("agent-device shim", () => {
  beforeEach(async () => {
    await daemon.ensure(launch());
  });

  it("refuses a command without --config and --session, and says what to do", async () => {
    for (const args of [
      ["snapshot", "-i"],
      ["snapshot", "--config", "/c.json"],
      ["snapshot", "--config", "--session", "s"],
    ]) {
      const result = await runShim(args);
      expect(result).toEqual({ code: 1, stdout: "", stderr: "Call the device tool with action open first and keep its --config and --session flags.\n" });
    }
  });

  it("runs the pinned CLI with the agent's flags and without variables that would point it elsewhere", async () => {
    const result = await runShim(["snapshot", "-i", "--config", daemon.paths.config, "--session", "openorc-1"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args: ["snapshot", "-i", "--config", daemon.paths.config, "--session", "openorc-1"], baseUrl: null, token: null });
  });

  it("lets help and version through on their own", async () => {
    for (const flag of ["--help", "version"]) expect(JSON.parse((await runShim([flag])).stdout)).toMatchObject({ args: [flag] });
  });
});
