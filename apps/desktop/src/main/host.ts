import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { HostChoice } from "../shared/host";
import type { Distro } from "./wsl/distro";

/**
 * Where the app's core runs: on this computer, as it always has, or inside a WSL distribution on Windows. Kept in a
 * file of its own because main reads it before any core starts. Only a choice someone made is ever written: a
 * missing or unreadable file means this computer.
 */
export class HostPreferences {
  constructor(private readonly file: string) {}

  choice(): HostChoice {
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as { host?: { kind?: unknown; distro?: unknown } } | null;
      const host = value?.host;
      if (host?.kind === "wsl" && typeof host.distro === "string" && /^[\w.-]{1,128}$/.test(host.distro)) return { kind: "wsl", distro: host.distro };
    } catch {
      // No file is the common case: nobody chose anything.
    }
    return { kind: "local" };
  }

  set(host: HostChoice): void {
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify({ host })}\n`);
    renameSync(`${this.file}.tmp`, this.file);
  }
}

const PROFILE = /^[0-9a-f]{16}$/;

/**
 * The name of this application data folder's profile inside a distribution, kept in `file` there and made the first
 * time it is asked for. A folder's secrets for a distribution stay in the folder, so its ledger there has to be its
 * own too: a second folder on this PC, such as a test's, never opens the first one's conversations.
 */
export function wslProfile(file: string): string {
  let kept = "";
  try {
    kept = readFileSync(file, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (kept) {
    // Never a new name over one that cannot be read: that would leave the profile it named behind for good.
    if (!PROFILE.test(kept)) throw new Error(`${file} does not name a profile.`);
    return kept;
  }
  const name = randomBytes(8).toString("hex");
  // On disk before it is used: a name lost to a power cut would leave the profile made under it behind.
  writeFileSync(`${file}.tmp`, `${name}\n`, { flush: true });
  renameSync(`${file}.tmp`, file);
  return name;
}

/**
 * The paths of the place the core runs, as main and the core each name them. On this computer they are one and the
 * same, and every function here gives back what it was given. Inside a distribution the core speaks Linux paths while
 * main opens files through the share Windows mounts for it.
 */
export interface HostPaths {
  /** A path the core named, as main opens it. */
  toMain(path: string): string;
  /** A path main was given, as the core names it; null when the core cannot reach it. */
  toCore(path: string): string | null;
  /** The core's profile folder, as main opens it. */
  dataDir(): string;
  /** The distribution the core is inside; null on this computer. */
  readonly distro: Distro | null;
}

export function localPaths(dataDir: string): HostPaths {
  return { toMain: (path) => path, toCore: (path) => path, dataDir: () => dataDir, distro: null };
}

/**
 * A distribution's paths. Its profile folder is known only once the distribution has answered where the user's home
 * is; until then it names a folder that holds nothing, and no window has anything to ask for yet.
 */
export function distroPaths(distro: Distro, profile: () => string | null, nowhere: string): HostPaths {
  return {
    toMain: (path) => distro.toHost(path),
    toCore: (path) => distro.toInside(path),
    dataDir: () => {
      const inside = profile();
      return inside ? distro.toHost(inside) : nowhere;
    },
    distro,
  };
}

let active: HostPaths | null = null;

/** The paths of the core main started last. Read at each use: switching where the core runs replaces them. */
export function hostPaths(): HostPaths {
  if (!active) throw new Error("No core has been started.");
  return active;
}

export function useHostPaths(paths: HostPaths): void {
  active = paths;
}

/** The distribution the core runs inside, or null: on this computer, and before any core has started. */
export function hostDistro(): Distro | null {
  return active?.distro ?? null;
}
