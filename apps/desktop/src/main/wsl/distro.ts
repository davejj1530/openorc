import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { wslPaths } from "./paths";

export interface DistroResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/**
 * One WSL distribution as main uses it: programs started inside it, and its paths as Windows opens them. Everything
 * goes from Windows into the distribution, through wsl.exe and the share Windows mounts for it; nothing here needs the
 * distribution to reach back, so one with interop or its Windows drives switched off works the same.
 */
export interface Distro {
  readonly name: string;
  /**
   * Starts a program inside, in the user's home folder there, given its arguments as they stand: no shell reads them.
   * Callers keep each argument to plain words; anything longer goes in on the program's input.
   */
  spawn(argv: readonly string[]): ChildProcessWithoutNullStreams;
  /** The same, to its end. `input` is written to it whole, such as an archive it unpacks. */
  run(argv: readonly string[], options?: { input?: Buffer; timeoutMs?: number }): Promise<DistroResult>;
  /** A path inside, as main opens it. */
  toHost(inside: string): string;
  /** A path main was given, as the distribution names it; null when it is not inside. */
  toInside(host: string): string | null;
  /** What a Terminal panel starts for a shell in `cwd`, a path inside; with the folder main starts it from, where that matters. */
  terminal(cwd: string): { file: string; args: string[]; cwd?: string };
}

const OUTPUT_LIMIT = 4 * 1024 * 1024;

/** wsl.exe writes its own text as UTF-16 unless WSL_UTF8 is set, which older versions do not read; either is taken. */
export function decodeWslText(bytes: Buffer): string {
  const utf16 = bytes.length >= 2 && bytes.length % 2 === 0 && bytes.subarray(0, Math.min(bytes.length, 64)).includes(0);
  return (utf16 ? bytes.toString("utf16le") : bytes.toString("utf8")).replace(/^\uFEFF/, "").replace(/\r/g, "");
}

function runTo(child: ChildProcessWithoutNullStreams, options: { input?: Buffer; timeoutMs?: number } = {}): Promise<DistroResult> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let held = 0;
    const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : null;
    child.stdout.on("data", (chunk: Buffer) => {
      if ((held += chunk.length) <= OUTPUT_LIMIT) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64) stderr.push(chunk);
    });
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      // What a program inside wrote is UTF-8; what wsl.exe itself says, such as that no such distribution exists, may not be.
      resolve({ code, stdout: Buffer.concat(stdout), stderr: decodeWslText(Buffer.concat(stderr)).slice(-8000) });
    });
    // A program that ends before reading everything reports that by its exit, not by this pipe.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  });
}

/** Where Windows keeps wsl.exe. Named in full, so a program of the same name earlier on PATH is never started instead. */
export function wslExe(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows", "System32", "wsl.exe");
}

/** A distribution on this PC, reached through wsl.exe. */
export function wslDistro(name: string, exe: string = wslExe()): Distro {
  const paths = wslPaths(name);
  // --exec starts the program itself; without it wsl.exe would hand the line to the user's shell to read. --cd ~ starts
  // it in the user's home there, wherever Windows started the app.
  const start = (argv: readonly string[]) =>
    spawn(exe, ["--distribution", name, "--cd", "~", "--exec", ...argv], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, WSL_UTF8: "1" } });
  return {
    name,
    spawn: start,
    run: (argv, options) => runTo(start(argv), options),
    toHost: paths.toWindows,
    toInside: paths.toLinux,
    // No program named: wsl.exe starts the account's own shell as a login shell, as Windows Terminal does.
    terminal: (cwd) => ({ file: exe, args: ["--distribution", name, "--cd", cwd] }),
  };
}

/**
 * This machine standing in for a distribution, where there is no wsl.exe: programs start here and paths are their
 * own. Development builds and tests on macOS and Linux run the whole WSL route through it.
 */
export function standInDistro(name = "stand-in", env: NodeJS.ProcessEnv = process.env): Distro {
  const start = (argv: readonly string[]) => spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], env, cwd: env["HOME"] || os.homedir() });
  return {
    name,
    spawn: start,
    run: (argv, options) => runTo(start(argv), options),
    toHost: (inside) => inside,
    toInside: (host) => (path.isAbsolute(host) ? host : null),
    terminal: (cwd) => ({ file: os.userInfo().shell || "/bin/sh", args: ["-l"], cwd }),
  };
}
