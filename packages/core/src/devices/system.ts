import { spawn } from "node:child_process";
import { createServer } from "node:net";
import os from "node:os";
import { createInterface } from "node:readline";

export type ProcessEnv = Readonly<Record<string, string>>;

export interface RunResult {
  /** Null when the command could not start or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ChildHandle {
  readonly pid: number;
  /** Settles once, when the process has exited or failed to start. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  kill(signal: NodeJS.Signals): void;
}

/**
 * Everything the device helpers ask of the machine: processes, signals, a loopback port and the clock. The app uses
 * `nodeSystem`; tests hand in a fake so no simctl, adb, npm or hub ever runs.
 */
export interface DeviceSystem {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  run(command: string, args: string[], options?: { env?: ProcessEnv; cwd?: string; timeoutMs?: number }): Promise<RunResult>;
  spawn(command: string, args: string[], options: { env: ProcessEnv; onOutput(line: string): void }): ChildHandle;
  alive(pid: number): boolean;
  signal(pid: number, signal: NodeJS.Signals): void;
  /** A loopback port that was free a moment ago. */
  reservePort(): Promise<number>;
  now(): number;
  /** Resolves after `ms`, or early when `signal` aborts. */
  delay(ms: number, signal?: AbortSignal): Promise<void>;
}

const OUTPUT_LIMIT = 4 * 1024 * 1024;

export const nodeSystem: DeviceSystem = {
  platform: process.platform,
  home: os.homedir(),
  run: (command, args, options = {}) =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn(command, args, { env: options.env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs)
        : null;
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        resolve({ code: null, stdout, stderr: stderr || error.message, timedOut });
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
    }),
  spawn: (command, args, options) => {
    const child = spawn(command, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on("line", options.onOutput);
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on("error", () => resolve({ code: null, signal: null }));
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    return { pid: child.pid ?? -1, exited, kill: (signal) => child.kill(signal) };
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  signal: (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  },
  reservePort: () =>
    new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close(() => (port ? resolve(port) : reject(new Error("No loopback port was free."))));
      });
    }),
  now: () => Date.now(),
  delay: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    }),
};

/** The command line of a live process, or "" when it is gone or unreadable. */
export async function commandLine(system: DeviceSystem, pid: number): Promise<string> {
  if (!system.alive(pid)) return "";
  const result = await system.run("ps", ["-o", "command=", "-p", String(pid)], { timeoutMs: 5000 });
  return result.code === 0 ? result.stdout.trim() : "";
}

/** Every process whose command line contains all of `parts`. */
export async function findProcesses(system: DeviceSystem, parts: string[]): Promise<number[]> {
  const result = await system.run("ps", ["-axo", "pid=,command="], { timeoutMs: 5000 });
  if (result.code !== 0) return [];
  const pids: number[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && parts.every((part) => match[2]!.includes(part))) pids.push(Number(match[1]));
  }
  return pids;
}

/** SIGTERM, then SIGKILL if it is still alive after `graceMs`. */
export async function terminate(system: DeviceSystem, pid: number, graceMs = 3000): Promise<void> {
  system.signal(pid, "SIGTERM");
  const deadline = system.now() + graceMs;
  while (system.alive(pid) && system.now() < deadline) await system.delay(100);
  if (system.alive(pid)) system.signal(pid, "SIGKILL");
}

/** Stops a child we spawned: SIGTERM, then SIGKILL after `graceMs`. Resolves once it has exited. */
export async function stopChild(system: DeviceSystem, child: ChildHandle, graceMs = 3000): Promise<void> {
  child.kill("SIGTERM");
  const grace = new AbortController();
  const stopped = await Promise.race([child.exited.then(() => true), system.delay(graceMs, grace.signal).then(() => false)]);
  grace.abort();
  if (stopped) return;
  child.kill("SIGKILL");
  await child.exited;
}
