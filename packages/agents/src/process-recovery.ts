import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Writable } from "node:stream";
import { launchCommand } from "./command-launch.js";
import { stopProcess } from "./process-lifetime.js";

interface ProcessReceipt {
  pid: number;
  started: string;
  owner: number;
  ownerStarted: string;
}
interface LaunchOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  registry?: string;
}

function identity(pid: number): string | null {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return null;
    throw new Error(`Could not verify agent process ${pid}. New work is blocked until process ownership can be checked.`, { cause: error });
  }
}
function exists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
function remove(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** The provider cannot execute until its process identity is durably retained. */
export function spawnAgentProcess(binary: string, args: string[], options: LaunchOptions): ChildProcessWithoutNullStreams {
  const { registry, ...launch } = options;
  if (!registry || process.platform === "win32") {
    const command = launchCommand(binary, args);
    return spawn(command.file, command.args, { ...launch, ...command.options, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  }
  mkdirSync(registry, { recursive: true, mode: 0o700 });
  const proc = spawn("/bin/sh", ["-c", 'IFS= read -r ready <&3 || exit 125; [ "$ready" = start ] || exit 125; exec 3<&-; exec "$@"', "openorc-agent", binary, ...args], {
    ...launch,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    detached: true,
  });
  // Install an error observer before synchronous receipt setup can throw.
  proc.on("error", () => {});
  const gate = proc.stdio[3] as Writable;
  const file = path.join(registry, `${randomUUID()}.json`);
  gate.on("error", () => {
    try {
      stopProcess(proc);
    } catch {
      /* The receipt blocks unsafe restart. */
    }
  });
  try {
    if (!proc.pid) throw new Error("Could not start the agent process gate.");
    const started = identity(proc.pid),
      ownerStarted = identity(process.pid);
    if (!started || !ownerStarted) throw new Error("Could not identify the agent process before launch.");
    const receipt: ProcessReceipt = { pid: proc.pid, started, owner: process.pid, ownerStarted };
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(receipt));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const directory = openSync(registry, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    proc.once("close", () => {
      try {
        if (!exists(receipt.pid)) remove(file);
      } catch {
        /* Startup will verify the retained process group. */
      }
    });
    gate.end("start\n");
    return proc;
  } catch (error) {
    gate.destroy();
    stopProcess(proc);
    throw error;
  }
}

function readReceipt(file: string): ProcessReceipt {
  const raw = readFileSync(file, "utf8");
  if (raw.length > 4096) throw new Error("Agent process receipt is invalid. Preserve it for recovery.");
  const value = JSON.parse(raw) as Partial<ProcessReceipt>;
  if (
    !value ||
    !Number.isSafeInteger(value.pid) ||
    value.pid! <= 1 ||
    !Number.isSafeInteger(value.owner) ||
    value.owner! <= 1 ||
    typeof value.started !== "string" ||
    !value.started ||
    typeof value.ownerStarted !== "string" ||
    !value.ownerStarted
  )
    throw new Error("Agent process receipt is invalid. Preserve it for recovery.");
  return value as ProcessReceipt;
}
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
async function stopRetained(receipt: ProcessReceipt): Promise<void> {
  const started = identity(receipt.pid);
  if (started && started !== receipt.started) return; // PID belongs to a later process; never signal it.
  if (!exists(receipt.pid)) return;
  if (!started) throw new Error(`Agent process group ${receipt.pid} still exists without its original leader. Stop that group before restarting OpenOrc; replacement agents remain blocked.`);
  if (identity(receipt.owner) === receipt.ownerStarted) throw new Error("Another OpenOrc core still owns agent processes in this profile. Close that instance before continuing.");
  const signal = (kind: NodeJS.Signals) => {
    try {
      process.kill(-receipt.pid, kind);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + 5000;
  const escalate = Date.now() + 500;
  let killed = false;
  while (exists(receipt.pid)) {
    if (Date.now() >= deadline) throw new Error(`Agent process group ${receipt.pid} has not stopped. New work remains blocked.`);
    if (!killed && Date.now() >= escalate) {
      const current = identity(receipt.pid);
      if (current && current !== receipt.started) return;
      signal("SIGKILL");
      killed = true;
    }
    await delay();
  }
}

/** Run before database recovery, queues, schedules or any replacement writer. */
export async function recoverAgentProcesses(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  let files: string[];
  try {
    files = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of files.filter((name) => name.endsWith(".json"))) {
    const file = path.join(directory, name);
    let receipt: ProcessReceipt;
    try {
      receipt = readReceipt(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await stopRetained(receipt);
    remove(file);
  }
}
