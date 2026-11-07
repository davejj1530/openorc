import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { checkSandbox, type CheckProgress } from "./check.js";
import { LocalSandboxProvider } from "./local-sandbox.js";
import { runnerFiles } from "./runner-client.js";

let base: string;
let bin: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "openorc-check-"));
  bin = path.join(base, "bin");
  await mkdir(bin);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A sandbox service whose VMs find `claude` only when `withClaude` is set. */
async function provider(withClaude: boolean): Promise<LocalSandboxProvider> {
  if (withClaude) {
    await writeFile(path.join(bin, "claude"), `#!/bin/sh\necho "2.1.316 (Claude Code)"\n`);
    await chmod(path.join(bin, "claude"), 0o755);
  }
  return new LocalSandboxProvider(path.join(base, "sandboxes"), () => ({ ...process.env, PATH: `${bin}:/usr/bin:/bin:${path.dirname(process.execPath)}` }));
}

it("passes every step in a throwaway sandbox, says what it found, and deletes the sandbox", async () => {
  const sandboxes = await provider(true);
  const progress: CheckProgress[] = [];
  const passed = await checkSandbox(sandboxes, { files: runnerFiles(), node: process.execPath, report: (entry) => progress.push(entry) });
  expect(progress.filter((entry) => entry.state === "failed")).toEqual([]);
  expect(passed).toBe(true);
  expect(progress.filter((entry) => entry.state === "done").map((entry) => entry.step)).toEqual(["sandbox", "tools", "runner", "relay", "sync", "remove"]);
  // A sandbox on this Mac has no firewall to keep sign-ins out of it: the step does not apply, and is no failure.
  expect(progress.find((entry) => entry.step === "signins" && entry.state === "skipped")?.detail).toBe("Sandboxes on this Mac use this Mac's sign-ins.");
  expect(progress.find((entry) => entry.step === "tools" && entry.state === "done")?.detail).toMatch(/^Node \d+\.\d+\.\d+ · Git \S+ · Claude Code 2\.1\.316$/);
  expect(await readdir(path.join(base, "sandboxes"))).toEqual([]);
  await sandboxes.close();
}, 60_000);

it("stops at the first step that fails, and still deletes the sandbox", async () => {
  const sandboxes = await provider(false);
  const progress: CheckProgress[] = [];
  const passed = await checkSandbox(sandboxes, { files: runnerFiles(), node: process.execPath, report: (entry) => progress.push(entry) });
  expect(passed).toBe(false);
  expect(progress.filter((entry) => entry.state !== "running").map((entry) => [entry.step, entry.state])).toEqual([
    ["sandbox", "done"],
    ["tools", "failed"],
    ["remove", "done"],
  ]);
  expect(progress.find((entry) => entry.state === "failed")?.error).toBe("Claude Code is not installed in the sandbox.");
  expect(existsSync(path.join(base, "sandboxes")) ? await readdir(path.join(base, "sandboxes")) : []).toEqual([]);
  await sandboxes.close();
}, 60_000);
