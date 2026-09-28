import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { CorePush } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";

it.skipIf(process.platform === "win32")("blocks database and queue recovery when process ownership cannot be verified, with an actionable startup message", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-startup-recovery-"));
  const registry = path.join(dataDir, "agent-processes");
  const pushes: CorePush[] = [];
  try {
    await mkdir(registry);
    await writeFile(path.join(registry, "interrupted.json"), "{}");
    await expect(OpenOrc.create({ dataDir, transport: { push: (message) => pushes.push(message) } })).rejects.toThrow(/receipt is invalid/);
    expect(pushes).toEqual([{ type: "startup", message: expect.stringMatching(/Agent recovery needs attention.*Preserve it for recovery/) }]);
    expect(await readdir(dataDir)).toEqual(["agent-processes"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
