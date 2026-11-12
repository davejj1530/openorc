import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { WslCore, type CoreChild } from "./core";
import type { Distro } from "./distro";
import { ensureRuntime, WslSetupError, type CarriedFile, type RuntimeSource } from "./runtime";

/** What `pnpm --filter @openorc/desktop bundle:wsl` writes, named by what it holds. */
const CORE = /^wsl-core-([A-Za-z0-9._-]{1,64})\.tgz$/;
/** The cloud brain's archive and its door, as apps/brain builds them. */
const BRAIN = /^(brain-[A-Za-z0-9_-]{1,64}\.tgz|door-[0-9a-f]{12}\.mjs)$/;

/** The core's archive in the folder the app carries it in: the newest, when a rebuild left more than one. */
export async function carriedCore(dir: string): Promise<RuntimeSource["core"] | null> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => CORE.test(name));
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? -1 })));
  const newest = dated.filter((entry) => entry.at >= 0).sort((a, b) => b.at - a.at)[0];
  return newest ? { version: CORE.exec(newest.name)![1]!, read: () => readFile(join(dir, newest.name)) } : null;
}

/** The cloud brain's files the app carries, which the core inside the distribution installs from for Settings > Cloud. */
export async function carriedBrain(dir: string | null): Promise<CarriedFile[]> {
  if (!dir) return [];
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => BRAIN.test(name));
  return names.map((name) => ({ name, read: () => readFile(join(dir, name)) }));
}

export interface WslCoreInput {
  distro: Distro;
  /** The folder the app carries the core's archive in. */
  coreDir: string;
  /** The folder it carries the cloud brain in; null when it carries none. */
  brainDir: string | null;
  /** Signs the file panel's viewer URLs, as for a utility process. */
  fileKey: string;
  qa: boolean;
  /** Downloads Node's archive, through the app's own network stack so a proxy the PC uses is honoured. */
  fetchNode(url: string): Promise<Buffer>;
  /** Hears where the core keeps its profile inside the distribution, once the distribution has said where home is. */
  profile(dataDir: string): void;
  log?(line: string): void;
}

/**
 * The core inside a distribution, from choosing the distribution to the core answering: whatever it needs is installed
 * there first, then it starts under wsl.exe and is given its start line.
 */
export function startWslCore(input: WslCoreInput): WslCore {
  return new WslCore(async (progress) => {
    const core = await carriedCore(input.coreDir);
    if (!core) throw new WslSetupError("This build of OpenOrc carries no core for WSL. Build it with pnpm --filter @openorc/desktop bundle:wsl, or install a release.");
    const runtime = await ensureRuntime(input.distro, { core, brain: await carriedBrain(input.brainDir), fetchNode: input.fetchNode }, progress);
    input.profile(runtime.dataDir);
    progress(`Starting OpenOrc in ${input.distro.name}…`);
    const child = input.distro.spawn(runtime.command) as unknown as CoreChild;
    return { child, start: { t: "start", dataDir: runtime.dataDir, fileKey: input.fileKey, ...(input.qa ? { qa: true } : {}) } };
  }, input.log);
}
