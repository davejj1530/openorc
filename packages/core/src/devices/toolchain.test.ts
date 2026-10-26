import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceMachine } from "./fixtures/device-machine.js";
import { DeviceToolchain, resolveRuntime, type DeviceRuntime } from "./toolchain.js";

let dir: string;
let machine: DeviceMachine;
let toolchain: DeviceToolchain;
let runtime: DeviceRuntime;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openorc-toolchain-test-"));
  machine = await new DeviceMachine(dir).setup();
  toolchain = new DeviceToolchain(path.join(dir, "devices"), machine.system);
  runtime = { node: path.join(machine.bin, "node"), npm: path.join(machine.bin, "npm"), env: machine.snapshot().env };
});

afterEach(async () => {
  await machine.close();
  await rm(dir, { recursive: true, force: true });
});

describe("resolveRuntime", () => {
  it("accepts Node.js 22.12 and later from the login shell's PATH", async () => {
    for (const version of ["v22.12.0", "v23.0.1", "v26.1.0"]) {
      machine.nodeVersion = version;
      expect(await resolveRuntime(machine.snapshot(), machine.system)).toEqual({ ok: true, runtime });
    }
  });

  it("names what blocks it: an old or missing Node.js, or no npm", async () => {
    machine.nodeVersion = "v22.11.9";
    expect(await resolveRuntime(machine.snapshot(), machine.system)).toEqual({ ok: false, blocked: "Device support needs Node.js 22.12 or later." });
    machine.nodeVersion = "v24.0.0";
    await rm(path.join(machine.bin, "npm"));
    expect(await resolveRuntime(machine.snapshot(), machine.system)).toEqual({ ok: false, blocked: "Device support needs npm, which comes with Node.js." });
    await rm(path.join(machine.bin, "node"));
    expect(await resolveRuntime(machine.snapshot(), machine.system)).toEqual({ ok: false, blocked: "Device support needs Node.js 22.12 or later." });
  });
});

describe("DeviceToolchain", () => {
  it("installs from the pinned lockfile with scripts off, and only once", async () => {
    let manifest: unknown;
    let lock: { packages: Record<string, { version?: string; integrity?: string }> } | null = null;
    machine.duringInstall = async () => {
      const call = machine.system.runs.at(-1)!;
      manifest = JSON.parse(await readFile(path.join(call.cwd!, "package.json"), "utf8"));
      lock = JSON.parse(await readFile(path.join(call.cwd!, "package-lock.json"), "utf8")) as typeof lock;
    };
    const entry = await toolchain.ensureInstalled("expo-device-hub", runtime);

    const npm = machine.system.runs.find((call) => call.command === runtime.npm)!;
    expect(npm.args).toEqual(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    expect(manifest).toEqual({ private: true, dependencies: { "expo-device-hub": "0.18.0" } });
    expect(lock!.packages["node_modules/expo-device-hub"]).toMatchObject({ version: "0.18.0", integrity: expect.stringMatching(/^sha512-/) });
    expect(entry).toBe(path.join(dir, "devices", "tools", "expo-device-hub", "0.18.0", "node_modules", "expo-device-hub", "dist", "server", "cli.mjs"));
    expect(await readFile(path.join(dir, "devices", "tools", "expo-device-hub", "0.18.0", ".install-complete"), "utf8")).toBe("0.18.0\n");

    await toolchain.ensureInstalled("expo-device-hub", runtime);
    expect(machine.installs).toEqual(["expo-device-hub"]);
    expect(await toolchain.status()).toEqual([
      { name: "expo-device-hub", pinned: "0.18.0", installed: "0.18.0" },
      { name: "agent-device", pinned: "0.21.31", installed: null },
    ]);
  });

  it("leaves nothing that looks installed when npm fails", async () => {
    machine.npmExit = 7;
    await expect(toolchain.ensureInstalled("agent-device", runtime)).rejects.toThrow("Installing agent-device failed: npm exited with code 7.");
    expect(await readdir(path.join(dir, "devices", "tools", "agent-device"))).toEqual([]);
    expect(await toolchain.installed("agent-device")).toBeNull();
  });

  it("runs one install at a time", async () => {
    let running = 0;
    let most = 0;
    machine.duringInstall = async () => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running--;
    };
    await Promise.all([toolchain.ensureInstalled("expo-device-hub", runtime), toolchain.ensureInstalled("agent-device", runtime)]);
    expect(most).toBe(1);
    expect(machine.installs.sort()).toEqual(["agent-device", "expo-device-hub"]);
  });
});
