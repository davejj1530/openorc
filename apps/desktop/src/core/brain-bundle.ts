import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrainBundleSource } from "@openorc/core";

/** What `pnpm --filter @openorc/brain bundle` writes, named by its version: the brain, and the door that wakes it. */
const ARCHIVE = /^brain-([A-Za-z0-9_-]{1,64})\.tgz$/;
const DOOR = /^door-([0-9a-f]{12})\.mjs$/;

/** The newest file in the folder whose name matches, with what the name says; null when it holds none. */
async function newest(dir: string, names: string[], pattern: RegExp): Promise<{ file: string; named: string } | null> {
  // A build replaces the files, so one listed may be gone by the time it is looked at.
  const dated = await Promise.all(names.filter((name) => pattern.test(name)).map(async (name) => ({ name, at: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? -1 })));
  const found = dated.filter((entry) => entry.at >= 0).sort((a, b) => b.at - a.at)[0];
  return found ? { file: join(dir, found.name), named: pattern.exec(found.name)![1]! } : null;
}

/** The newest brain archive in the folder, read only when a brain is set up, with its door; null when the folder holds none. */
export async function newestBrainBundle(dir: string): Promise<BrainBundleSource | null> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const [brain, door] = await Promise.all([newest(dir, names, ARCHIVE), newest(dir, names, DOOR)]);
  if (!brain) return null;
  return { version: brain.named, read: () => readFile(brain.file), ...(door ? { door: { release: door.named, code: () => readFile(door.file) } } : {}) };
}
