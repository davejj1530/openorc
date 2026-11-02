import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrainBundleSource } from "@openorc/core";

/** What `pnpm --filter @openorc/brain bundle` writes, named by its version. */
const ARCHIVE = /^brain-([A-Za-z0-9_-]{1,64})\.tgz$/;

/** The newest brain archive in the folder, read only when a brain is set up; null when the folder holds none. */
export async function newestBrainBundle(dir: string): Promise<BrainBundleSource | null> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => ARCHIVE.test(name));
  // A build replaces the archive, so one listed may be gone by the time it is looked at.
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? -1 })));
  const newest = dated.filter((entry) => entry.at >= 0).sort((a, b) => b.at - a.at)[0];
  if (!newest) return null;
  const file = join(dir, newest.name);
  return { version: ARCHIVE.exec(newest.name)![1]!, read: () => readFile(file) };
}
