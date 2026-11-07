import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessId } from "@openorc/protocol";
import { inFolder } from "./launch-environment.js";
import type { HostHome } from "./session-slot.js";

/** An agent's folders on this machine, and its CLI here started with `processEnv` plus the folder variables. */
export function hostHome(input: { agent: HarnessId; userHome: string; env: Record<string, string>; binary: string; processEnv: NodeJS.ProcessEnv }): HostHome {
  const env = { ...input.processEnv, ...input.env };
  return {
    agent: input.agent,
    machine: "here",
    userHome: input.userHome,
    env: input.env,
    binary: input.binary,
    read: (file) => readFile(file).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error))),
    async write(file, bytes) {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const beside = `${file}.${randomUUID()}.partial`;
      await writeFile(beside, bytes, { mode: 0o600 });
      await rename(beside, file);
    },
    remove: (file) => rm(file, { force: true }),
    async list(dir, options) {
      const entries = await readdir(dir, { recursive: Boolean(options?.recursive), withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
        throw error;
      });
      if (!options?.recursive) return entries.map((entry) => entry.name);
      return entries.filter((entry) => entry.isFile()).map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
    },
    realpath: (file) => realpath(file).catch(() => file),
    run: (args, options) =>
      new Promise((resolve, reject) => {
        const child = spawn(input.binary, [...args], { ...(options?.cwd ? { cwd: options.cwd } : {}), env: options?.cwd ? inFolder(env, options.cwd) : env, stdio: ["ignore", "pipe", "pipe"] });
        const stdout: Buffer[] = [];
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), options?.timeoutMs ?? 120_000);
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-8000)));
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr });
        });
      }),
    // Its own process group, so stopping it ends whatever it started.
    spawn: (args, options): ChildProcessWithoutNullStreams =>
      spawn(input.binary, [...args], { cwd: options.cwd, env: inFolder(env, options.cwd), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" }),
  };
}
