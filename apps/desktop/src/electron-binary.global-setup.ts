import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ATTEMPTS = 4;

/** Whether the Electron package in `folder` has its binary where it says it is. */
function hasBinary(folder: string): boolean {
  const named = path.join(folder, "path.txt");
  return existsSync(named) && existsSync(path.join(folder, "dist", readFileSync(named, "utf8")));
}

/**
 * Fetches the binary of the Electron package in `folder` unless it is there, trying again while the download fails.
 * Electron fetches it itself on first use, but test files in parallel workers each fetch and unpack into the same
 * folder, and one can launch an app another is still unpacking.
 */
export async function ensureElectronBinary(folder: string, wait = (attempt: number) => delay(attempt * 5000)): Promise<void> {
  for (let attempt = 1; !hasBinary(folder); attempt++) {
    const install = spawnSync(process.execPath, [path.join(folder, "install.js")], { stdio: "inherit" });
    if (install.status === 0 && hasBinary(folder)) return;
    if (attempt === ATTEMPTS) throw new Error(`Electron's binary could not be downloaded in ${ATTEMPTS} tries.`);
    await wait(attempt);
  }
}

export default async function setup(): Promise<void> {
  if (process.env["ELECTRON_OVERRIDE_DIST_PATH"]) return;
  await ensureElectronBinary(path.dirname(createRequire(import.meta.url).resolve("electron/package.json")));
}
