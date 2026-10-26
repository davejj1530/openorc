import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Device } from "@openorc/protocol";
import { writePrivateFile } from "./files.js";
import { commandLine, findProcesses, terminate, type DeviceSystem, type ProcessEnv } from "./system.js";

/** The user's node, the installed agent-device CLI and the environment it runs with. */
export interface AgentLaunch {
  node: string;
  entry: string;
  env: ProcessEnv;
}

export interface AgentDevicePaths {
  /** AGENT_DEVICE_STATE_DIR: daemon.json, daemon.lock and sessions. */
  stateDir: string;
  /** `{daemonBaseUrl, daemonAuthToken}` for `--config`. Exists only while agents have access. */
  config: string;
  /** Prepended to new runs' PATH. Holds the `agent-device` shim and its launcher. */
  binDir: string;
}

interface DaemonRecord {
  port: number;
  token: string;
  pid: number | null;
}

type DaemonState = { phase: "off" } | { phase: "starting"; launch: AgentLaunch; ready: Promise<number | null> } | { phase: "running"; launch: AgentLaunch; pid: number | null };

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const REFUSAL = "Call the device tool with action open first and keep its --config and --session flags.";

/** The agent-device session for one device in one conversation, so conversations never share a session. */
export function sessionName(surface: string, deviceId: string): string {
  return `openorc-${createHash("sha256")
    .update(JSON.stringify([surface, deviceId]))
    .digest("hex")
    .slice(0, 16)}`;
}

/**
 * The agent-device HTTP daemon that agents drive devices through. Its XCTest runners outlive it, so stopping it also
 * stops every runner whose command line names this daemon's pid as its owner.
 */
export class AgentDeviceDaemon {
  private state: DaemonState = { phase: "off" };

  constructor(
    readonly paths: AgentDevicePaths,
    private readonly system: DeviceSystem,
  ) {}

  get shim(): string {
    return path.join(this.paths.binDir, "agent-device");
  }

  /**
   * Starts the daemon, or reuses a healthy one, then writes the config file and the shim. Joins a start under way, and
   * starts again when the daemon it started has since died.
   */
  async ensure(launch: AgentLaunch): Promise<void> {
    if (this.state.phase === "running" && (await this.healthyRecord())) return;
    if (this.state.phase === "starting") {
      await this.state.ready;
      return;
    }
    const ready = this.start(launch);
    this.state = { phase: "starting", launch, ready };
    const current = () => this.state.phase === "starting" && this.state.ready === ready;
    try {
      const pid = await ready;
      if (current()) this.state = { phase: "running", launch, pid };
    } catch (error) {
      if (current()) this.state = { phase: "off" };
      throw error;
    }
  }

  /** Stops the daemon and its runners and deletes the config, so no agent can reach the daemon after access ends. */
  async stop(): Promise<void> {
    const { state } = this;
    this.state = { phase: "off" };
    if (state.phase === "starting") await state.ready.catch(() => undefined);
    const record = await this.record();
    const launch = state.phase === "off" ? null : state.launch;
    if (launch) {
      await this.system.run(launch.node, [launch.entry, "daemon", "stop", "--state-dir", this.paths.stateDir], { env: this.daemonEnv(launch.env), timeoutMs: STOP_TIMEOUT_MS });
    } else if (record?.pid && (await commandLine(this.system, record.pid)).includes("agent-device")) {
      await terminate(this.system, record.pid);
    }
    await this.stopRunners(record?.pid ?? (state.phase === "running" ? state.pid : null));
    await rm(this.paths.config, { force: true });
  }

  /** At startup: a daemon a previous core left behind, and the runners it left, are stopped. */
  async reapStale(): Promise<void> {
    if (this.state.phase !== "off") return;
    await this.stop();
  }

  /** Resolves to the daemon's pid, when it reports one. */
  private async start(launch: AgentLaunch): Promise<number | null> {
    await mkdir(this.paths.stateDir, { recursive: true, mode: 0o700 });
    let record = await this.healthyRecord();
    if (!record) {
      await rm(path.join(this.paths.stateDir, "daemon.json"), { force: true });
      // agent-device has no `daemon start`; listing devices is the cheapest command that starts the daemon and waits for it.
      await this.system.run(launch.node, [launch.entry, "devices", "--json"], { env: this.daemonEnv(launch.env), timeoutMs: START_TIMEOUT_MS });
      record = await this.awaitRecord();
    }
    await writePrivateFile(this.paths.config, JSON.stringify({ daemonBaseUrl: `http://127.0.0.1:${record.port}`, daemonAuthToken: record.token }));
    await this.writeShim(launch);
    return record.pid;
  }

  private daemonEnv(env: ProcessEnv): ProcessEnv {
    return {
      ...env,
      AGENT_DEVICE_STATE_DIR: this.paths.stateDir,
      AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
      // The core owns the daemon's lifetime; agent-device's own idle timeout would stop it under a waiting agent.
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
  }

  private async record(): Promise<DaemonRecord | null> {
    const raw = await readFile(path.join(this.paths.stateDir, "daemon.json"), "utf8").catch(() => null);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as { httpPort?: unknown; token?: unknown; pid?: unknown };
      if (typeof value.httpPort !== "number" || typeof value.token !== "string" || !value.token) return null;
      return { port: value.httpPort, token: value.token, pid: typeof value.pid === "number" ? value.pid : null };
    } catch {
      return null;
    }
  }

  private async healthyRecord(): Promise<DaemonRecord | null> {
    const record = await this.record();
    if (!record) return null;
    try {
      const response = await fetch(`http://127.0.0.1:${record.port}/health`, { signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      return response.status === 200 ? record : null;
    } catch {
      return null;
    }
  }

  private async awaitRecord(): Promise<DaemonRecord> {
    const deadline = this.system.now() + START_TIMEOUT_MS;
    for (;;) {
      const record = await this.record();
      if (record) return record;
      if (this.system.now() >= deadline) throw new Error("agent-device did not start within 30 seconds.");
      await this.system.delay(100);
    }
  }

  private async stopRunners(owner: number | null): Promise<void> {
    if (!owner) return;
    for (const pid of await findProcesses(this.system, ["AgentDeviceRunner", `-owner-${owner}-`])) await terminate(this.system, pid);
  }

  /** Rewritten on every start: the node it runs may have moved since the last one. */
  private async writeShim(launch: AgentLaunch): Promise<void> {
    const launcher = path.join(this.paths.binDir, "agent-device-launcher.mjs");
    await writePrivateFile(launcher, launcherSource(launch), 0o644);
    await writePrivateFile(this.shim, `#!/bin/sh\nexec ${shellQuote(launch.node)} ${shellQuote(launcher)} "$@"\n`, 0o755);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * The launcher refuses a command without `--config` and `--session` so an agent cannot reach a daemon or session of
 * its own choosing by accident, and drops the variables that would point agent-device elsewhere.
 */
function launcherSource(launch: AgentLaunch): string {
  return `import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const informational = args.length === 1 && ["help", "--help", "-h", "--version", "version"].includes(args[0]);
const hasValue = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 && Boolean(args[index + 1]) && !args[index + 1].startsWith("--");
};
if (!informational && !(hasValue("--config") && hasValue("--session"))) {
  console.error(${JSON.stringify(REFUSAL)});
  process.exit(1);
}
const env = { ...process.env };
delete env.AGENT_DEVICE_DAEMON_BASE_URL;
delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
delete env.AGENT_DEVICE_CONFIG;
const child = spawn(${JSON.stringify(launch.node)}, [${JSON.stringify(launch.entry)}, ...args], { stdio: "inherit", env });
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
`;
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : shellQuote(value);
}

/** How an agent drives the device it opened, returned by `open` so it costs nothing in conversations that never open one. */
export function howTo(device: Device, command: string, args: string[]): string {
  const executable = quote(command);
  const target = args.map(quote).join(" ");
  const firstUse =
    device.platform === "ios" ? "First use builds an XCTest runner and can take a couple of minutes; later commands are fast." : "The Android snapshot helper installs itself on first use.";
  return [
    `The user is watching ${device.name} (${device.os}) in the Device panel.`,
    `Drive it with ${executable}. Use this exact path; login shells may reset PATH. Always pass ${target}.`,
    "Typical loop:",
    `  ${executable} open <bundle-or-package-id> ${target}     # or: open <app> <deep-link-url>`,
    `  ${executable} snapshot -i ${target}                     # accessibility tree with @eN refs`,
    `  ${executable} click @e3 ${target}`,
    `  ${executable} fill @e5 "text" ${target}`,
    `  ${executable} install <app> <path-to-.app-or-.apk> ${target}`,
    `For a picture of the screen, call the device tool with action screenshot. Prefer snapshot refs over coordinates. Run ${executable} help for workflow guides and ${executable} <command> --help for flags.`,
    "Prefer agent-device for driving this device. simctl, adb and xcrun remain available for anything it does not cover.",
    "Keep the returned --config and --session flags on every command.",
    firstUse,
  ].join("\n");
}
