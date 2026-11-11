import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { INSTALL_LIMIT_MS, runUpdateCommand } from "./agent-update-installation.js";

const folders: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

const idle = ["-e", "setInterval(() => {}, 1000)"];
const turn = () => new Promise((resolve) => setImmediate(resolve));
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(done: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > 10_000) throw new Error(`Timed out waiting until ${what}`);
    await turn();
  }
}

/** An updater that starts a process of its own, as an installer does with its download, and says both ids once they run. */
async function updaterWithChild(options: Parameters<typeof runUpdateCommand>[2]) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "openorc-updater-"));
  folders.push(folder);
  const ids = path.join(folder, "ids");
  const script = `
    const child = require("node:child_process").spawn(process.execPath, ${JSON.stringify(idle)}, { stdio: "ignore" });
    require("node:fs").writeFileSync(${JSON.stringify(ids)}, process.pid + " " + child.pid);
    setInterval(() => {}, 1000);`;
  const operation = runUpdateCommand({ binary: process.execPath, args: ["-e", script] }, process.env, options);
  operation.catch(() => undefined);
  await until(() => existsSync(ids) && readFileSync(ids, "utf8").includes(" "), "the updater and its child run");
  const pids = readFileSync(ids, "utf8").split(" ").map(Number);
  expect(pids.every(running)).toBe(true);
  return { operation, stopped: () => until(() => !pids.some(running), "the updater and its child are gone") };
}

it("captures successful probe output without invoking a shell", async () => {
  expect(await runUpdateCommand({ binary: process.execPath, args: ["-e", "process.stdout.write(process.argv[1])", "literal $(echo unsafe)"] }, process.env)).toBe("literal $(echo unsafe)");
});
it("does not expose package-manager output on failure", async () => {
  await expect(runUpdateCommand({ binary: process.execPath, args: ["-e", "console.error('registry-token-secret'); process.exit(1)"] }, process.env)).rejects.toThrow(/^The updater could not finish\./);
});
it("bounds output and returns an actionable failure", async () => {
  await expect(runUpdateCommand({ binary: process.execPath, args: ["-e", "process.stdout.write('a'.repeat(2 * 1024 * 1024))"] }, process.env)).rejects.toThrow("updater could not finish");
});
it("lets an updater run for half an hour before stopping it", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let settled = false;
  const operation = runUpdateCommand({ binary: process.execPath, args: idle }, process.env);
  const assertion = expect(operation.finally(() => (settled = true))).rejects.toThrow("longer than 30 minutes");
  await vi.advanceTimersByTimeAsync(INSTALL_LIMIT_MS - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await assertion;
});
it("stops at the limit it is given, along with what the updater started", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const updater = await updaterWithChild({ limitMs: 8000 });
  await vi.advanceTimersByTimeAsync(8000);
  await expect(updater.operation).rejects.toThrow("was stopped");
  await updater.stopped();
});
it("stops when its signal aborts, along with what the updater started", async () => {
  const stop = new AbortController();
  const updater = await updaterWithChild({ signal: stop.signal });
  stop.abort();
  await expect(updater.operation).rejects.toThrow(/^The update was stopped\.$/);
  await updater.stopped();
});
it("starts nothing once its signal has aborted", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "openorc-updater-"));
  folders.push(folder);
  const mark = path.join(folder, "ran");
  const args = ["-e", `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "")`];
  await expect(runUpdateCommand({ binary: process.execPath, args }, process.env, { signal: AbortSignal.abort() })).rejects.toThrow("The update was stopped.");
  expect(existsSync(mark)).toBe(false);
});
it("handles a missing executable without leaking its environment", async () => {
  await expect(runUpdateCommand({ binary: "/openorc-fixture-missing/updater", args: [] }, { SECRET: "do-not-expose" })).rejects.toThrow("updater could not finish");
});
