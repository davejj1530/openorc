import { describe, expect, it } from "vitest";
import { ensureDocker } from "./docker.js";
import type { Sandbox, SandboxCommandOptions, SandboxExecResult } from "./sandbox.js";

interface Sent {
  how: "exec" | "launch";
  cmd: string;
  args: string[];
  sudo: boolean;
}

const result = (code: number, stdout = "", stderr = ""): SandboxExecResult => ({ code, stdout: Buffer.from(stdout), stderr });

/**
 * A VM as Docker's start sees it, told apart by what each command asks: whether Docker is installed, whether its
 * daemon runs and answers, and the user's group. Records every command it is sent.
 */
class StandInVm implements Sandbox {
  readonly name = "openorc-vm";
  readonly root = "/vercel/sandbox";
  readonly awayMs = 60_000;
  readonly sent: Sent[] = [];
  /** The daemon as started: its data root, socket group and log. */
  daemon: { dataRoot: string; group: string; log: string } | null = null;
  /** How many times the daemon is asked after it starts before it answers; null when it never does. */
  answersAfter: number | null = 0;
  private asked = 0;
  log = "";
  installOutput = { code: 0, stderr: "" };

  constructor(
    public installed: boolean,
    running: boolean,
  ) {
    if (running) this.daemon = { dataRoot: "/var/lib/docker", group: "vercel-sandbox", log: "" };
  }

  private answers(): boolean {
    if (!this.daemon || this.answersAfter === null) return false;
    return this.asked++ >= this.answersAfter;
  }

  async exec(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<SandboxExecResult> {
    this.sent.push({ how: "exec", cmd, args, sudo: Boolean(options.sudo) });
    const script = cmd === "sh" ? (args[1] ?? "") : "";
    if (script.includes("docker info")) return result(this.answers() ? 0 : 1);
    if (script.includes("command -v dockerd")) return result(this.installed ? 0 : 1);
    if (script.includes("apt-get install")) {
      this.installed = this.installOutput.code === 0;
      return result(this.installOutput.code, "Reading package lists...\n", this.installOutput.stderr);
    }
    if (cmd === "id" && args.join(" ") === "-gn") return result(0, "vercel-sandbox\n");
    if (cmd === "tail") return result(0, this.log);
    throw new Error(`The stand-in VM was not expecting ${cmd} ${args.join(" ")}`);
  }

  async launch(cmd: string, args: string[], options: SandboxCommandOptions = {}): Promise<void> {
    this.sent.push({ how: "launch", cmd, args, sudo: Boolean(options.sudo) });
    const [, script, , dataRoot, group, log] = args;
    if (cmd !== "sh" || !script?.includes("exec dockerd") || !options.sudo || !this.installed) return;
    this.daemon ??= { dataRoot: dataRoot!, group: group!, log: log! };
  }

  stream(): never {
    throw new Error("Not used.");
  }
  async writeFile(): Promise<void> {}
  async readFile(): Promise<Buffer | null> {
    return null;
  }
  async keepAwake(): Promise<void> {}
  async stop(): Promise<void> {}
}

const quick = { timeoutMs: 200, pollMs: 1 };
const installs = (vm: StandInVm) => vm.sent.filter((sent) => sent.args[1]?.includes("apt-get install"));

describe("starting Docker in a sandbox", () => {
  it("only asks while the daemon answers", async () => {
    const vm = new StandInVm(true, true);
    await ensureDocker(vm, quick);
    expect(vm.sent).toEqual([{ how: "exec", cmd: "sh", args: ["-c", expect.stringContaining("docker info")], sudo: false }]);
  });

  it("installs Docker as root when it is missing, then starts its daemon as root for the user's group, its data with the workspace's", async () => {
    const vm = new StandInVm(false, false);
    await ensureDocker(vm, quick);
    expect(installs(vm)).toEqual([expect.objectContaining({ sudo: true })]);
    expect(vm.daemon).toEqual({ dataRoot: "/vercel/sandbox/.openorc/docker", group: "vercel-sandbox", log: "/vercel/sandbox/.openorc/docker.log" });
    expect(vm.sent.filter((sent) => sent.how === "launch")).toEqual([expect.objectContaining({ sudo: true })]);
  });

  it("starts a daemon that is installed but not running without installing again", async () => {
    const vm = new StandInVm(true, false);
    await ensureDocker(vm, quick);
    expect(installs(vm)).toEqual([]);
    expect(vm.daemon?.dataRoot).toBe("/vercel/sandbox/.openorc/docker");
  });

  it("returns once docker info answers as the normal user, not before", async () => {
    const vm = new StandInVm(true, false);
    vm.answersAfter = 3;
    await ensureDocker(vm, quick);
    const asked = vm.sent.filter((sent) => sent.args[1]?.includes("docker info"));
    // Once before the start, then until the fourth answer after it.
    expect(asked).toHaveLength(5);
    expect(asked.every((sent) => !sent.sudo)).toBe(true);
    expect(vm.sent.at(-1)).toEqual(asked.at(-1));
  });

  it("fails with the end of the daemon's log when it does not answer in time", async () => {
    const vm = new StandInVm(true, false);
    vm.answersAfter = null;
    vm.log = 'level=info msg="Starting up"\nfailed to start daemon: Error initializing network controller: iptables not found\n';
    await expect(ensureDocker(vm, quick)).rejects.toThrow(/^Docker did not start in the sandbox\.\n[^]*iptables not found$/);
  });

  it("fails with what the install printed when installing fails", async () => {
    const vm = new StandInVm(false, false);
    vm.installOutput = { code: 100, stderr: "E: Unable to locate package docker.io" };
    await expect(ensureDocker(vm, quick)).rejects.toThrow("Docker could not be installed in the sandbox (exit 100).\nReading package lists...\nE: Unable to locate package docker.io");
    expect(vm.daemon).toBeNull();
  });
});
