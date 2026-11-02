import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { LocalSandboxProvider } from "./local-sandbox.js";

let base: string;
let provider: LocalSandboxProvider;

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "openorc-local-sandbox-"));
  provider = new LocalSandboxProvider(base, () => process.env, 300);
});

afterEach(async () => {
  await provider.close();
  await rm(base, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("stops on its own once nobody keeps it awake, keeps its files, and starts again with the next command", async () => {
  const sandbox = await provider.open("idle");
  await sandbox.writeFile(path.join(sandbox.root, "note.txt"), Buffer.from("kept"));
  const pidFile = path.join(sandbox.root, "pid");
  await sandbox.launch("sh", ["-c", `echo $$ > ${pidFile}; exec sleep 30`]);
  await sleep(200);
  const pid = Number((await sandbox.readFile(pidFile))?.toString().trim());

  await sandbox.keepAwake();
  await sleep(200);
  expect(alive(pid)).toBe(true);
  await sleep(400);
  expect(alive(pid)).toBe(false);

  expect((await sandbox.exec("cat", ["note.txt"])).stdout.toString()).toBe("kept");
});

it("deletes a sandbox and its files, stopping what runs there", async () => {
  const sandbox = await provider.open("doomed");
  const pidFile = path.join(sandbox.root, "pid");
  await sandbox.launch("sh", ["-c", `echo $$ > ${pidFile}; exec sleep 30`]);
  await sleep(100);
  const pid = Number((await sandbox.readFile(pidFile))?.toString().trim());
  await provider.remove("doomed");
  expect(alive(pid)).toBe(false);
  expect(existsSync(sandbox.root)).toBe(false);
});
