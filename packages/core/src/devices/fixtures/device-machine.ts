import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { EnvSnapshot } from "../../services/shell-environment.js";
import { FakeSystem, type RunCall } from "./fake-system.js";

export interface Simulator {
  udid: string;
  name: string;
  state: "Shutdown" | "Booted" | "Booting";
}

/**
 * A Mac with Node.js 24, npm, Xcode and a few simulators, all fake: npm "installs" by writing the entry file, simctl
 * reports `simulators`, and agent-device "starts" a daemon whose health check answers on loopback.
 */
export class DeviceMachine {
  readonly system: FakeSystem;
  readonly bin: string;
  nodeVersion = "v24.1.0";
  npmExit = 0;
  simulators: Simulator[] = [
    { udid: "IPHONE-17", name: "iPhone 17 Pro", state: "Shutdown" },
    { udid: "IPAD-AIR", name: "iPad Air", state: "Booted" },
  ];
  readonly installs: string[] = [];
  readonly daemonToken = "daemon-secret";
  daemonPid: number | null = null;
  private health: http.Server | null = null;
  /** Runs while npm "installs", so a test can look at the service mid-install. */
  duringInstall: (name: string) => Promise<void> = async () => undefined;

  constructor(readonly root: string) {
    this.system = new FakeSystem(root);
    this.bin = path.join(root, "bin");
    const command = (name: string) => (call: RunCall) => path.basename(call.command) === name;
    this.system.on(command("node"), (call) => this.node(call));
    this.system.on(command("npm"), (call) => this.npm(call));
    this.system.on(command("xcrun"), (call) => this.xcrun(call));
  }

  async setup(): Promise<this> {
    await mkdir(this.bin, { recursive: true });
    for (const name of ["node", "npm"]) {
      await writeFile(path.join(this.bin, name), "#!/bin/sh\nexit 0\n");
      await chmod(path.join(this.bin, name), 0o755);
    }
    this.health = http.createServer((request, response) => response.writeHead(request.url === "/health" ? 200 : 404).end());
    await new Promise<void>((resolve) => this.health!.listen(0, "127.0.0.1", resolve));
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.health ? this.health.close(() => resolve()) : resolve()));
  }

  snapshot(): EnvSnapshot {
    const env = { PATH: this.bin, HOME: this.root };
    return Object.freeze({ revision: 1, shell: "/bin/zsh", path: this.bin, binaries: { claude: null, codex: null, opencode: null }, env: Object.freeze(env) }) as EnvSnapshot;
  }

  /** `simctl` calls that changed or booted a simulator. */
  simctlWrites(): string[][] {
    return this.system.runs.filter((call) => call.command === "xcrun" && !["help", "list"].includes(call.args[1] ?? "")).map((call) => call.args);
  }

  private async node(call: RunCall): Promise<{ code: number; stdout?: string }> {
    if (call.args[0] === "--version") return { code: 0, stdout: `${this.nodeVersion}\n` };
    if (call.args[1] === "devices") {
      const stateDir = call.env!["AGENT_DEVICE_STATE_DIR"]!;
      this.daemonPid = this.system.process(`${call.command} ${call.args[0]} daemon`);
      const port = (this.health!.address() as { port: number }).port;
      await writeFile(path.join(stateDir, "daemon.json"), JSON.stringify({ httpPort: port, token: this.daemonToken, pid: this.daemonPid, version: "0.21.31" }));
      return { code: 0, stdout: "[]" };
    }
    if (call.args[1] === "daemon" && call.args[2] === "stop" && this.daemonPid) this.system.live.delete(this.daemonPid);
    return { code: 0 };
  }

  private async npm(call: RunCall): Promise<{ code: number }> {
    const manifest = JSON.parse(await readFile(path.join(call.cwd!, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const name = Object.keys(manifest.dependencies)[0]!;
    this.installs.push(name);
    await this.duringInstall(name);
    if (this.npmExit) return { code: this.npmExit };
    const entry = name === "agent-device" ? ["bin", "agent-device.mjs"] : ["dist", "server", "cli.mjs"];
    await mkdir(path.join(call.cwd!, "node_modules", name, ...entry.slice(0, -1)), { recursive: true });
    await writeFile(path.join(call.cwd!, "node_modules", name, ...entry), "");
    return { code: 0 };
  }

  private xcrun(call: RunCall): { code: number; stdout?: string } {
    const args = call.args.join(" ");
    if (args === "simctl help") return { code: 0 };
    if (args === "simctl list runtimes -j") {
      return { code: 0, stdout: JSON.stringify({ runtimes: [{ identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5", name: "iOS 26.5", platform: "iOS", isAvailable: true }] }) };
    }
    if (args === "simctl list devices available -j") {
      const devices = this.simulators.map((simulator) => ({ ...simulator, deviceTypeIdentifier: `com.apple.CoreSimulator.SimDeviceType.${simulator.name.replaceAll(" ", "-")}`, isAvailable: true }));
      return { code: 0, stdout: JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-5": devices } }) };
    }
    return { code: 0 };
  }
}
