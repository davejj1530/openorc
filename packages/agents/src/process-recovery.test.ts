import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { stopProcess, waitForProcessGroup } from "./process-lifetime.js";
import { recoverAgentProcesses, spawnAgentProcess } from "./process-recovery.js";

it.skipIf(process.platform === "win32").each([false, true])(
  "stops a real surviving writer after core SIGKILL (ignores TERM: %s)",
  async (ignoreTerm) => {
    const dir = await mkdtemp(path.join(tmpdir(), "openorc-crash-"));
    const binary = path.join(dir, "provider");
    const pidFile = path.join(dir, "writer.pid");
    const output = path.join(dir, "edits.txt");
    const registry = path.join(dir, "processes");
    await writeFile(
      binary,
      `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(output)}, 'initial\\n');
process.stdout.on('error', () => {});
${ignoreTerm ? "process.on('SIGTERM', () => {});" : ""}
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  if (r.id) process.stdout.write(JSON.stringify({id:r.id,result:r.method==='thread/start'?{thread:{id:'fixture'}}:{}})+'\\n');
});
setInterval(() => fs.appendFileSync(${JSON.stringify(output)}, 'edit\\n'), 20);
`,
      { mode: 0o755 },
    );
    let owner: ChildProcess | undefined;
    let pid: number | undefined;
    try {
      owner = fork(fileURLToPath(new URL("../test-fixtures/crash-owner.ts", import.meta.url)), [binary, dir, registry], {
        execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const ready = new Promise<void>((resolve, reject) => {
        owner!.once("message", () => resolve());
        owner!.once("exit", (code) => reject(new Error(`Owner exited early: ${code}`)));
        owner!.stderr?.on("data", (data: Buffer) => {
          if (String(data).includes("Error")) reject(new Error(String(data)));
        });
      });
      await ready;
      pid = Number(await readFile(pidFile, "utf8"));
      const exited = new Promise<void>((resolve) => owner!.once("exit", () => resolve()));
      owner.kill("SIGKILL");
      await exited;
      await recoverAgentProcesses(registry);
      const before = await readFile(output, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(await readFile(output, "utf8")).toBe(before);
    } finally {
      owner?.kill("SIGKILL");
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
  10000,
);

it.skipIf(process.platform === "win32")("blocks live owners, preserves malformed receipts and never signals a reused PID", async () => {
  const registry = await mkdtemp(path.join(tmpdir(), "openorc-ownership-"));
  const proc = spawnAgentProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: registry, env: process.env, registry });
  try {
    await expect(recoverAgentProcesses(registry)).rejects.toThrow(/Another OpenOrc core/);
    const file = path.join(registry, (await readdir(registry))[0]!);
    const receipt = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, "not a receipt");
    await expect(recoverAgentProcesses(registry)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("not a receipt");
    await writeFile(file, JSON.stringify({ ...receipt, started: "a different process birth" }));
    await recoverAgentProcesses(registry);
    expect(await readdir(registry)).toEqual([]);
    expect(() => process.kill(proc.pid!, 0)).not.toThrow();
  } finally {
    stopProcess(proc);
    await waitForProcessGroup(proc);
    await rm(registry, { recursive: true, force: true });
  }
});
