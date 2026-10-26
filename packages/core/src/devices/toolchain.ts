import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DeviceTool } from "@openorc/protocol";
import { resolveBinary, type EnvSnapshot } from "../services/shell-environment.js";
import agentDeviceLock from "./locks/agent-device.json";
import hubLock from "./locks/expo-device-hub.json";
import type { DeviceSystem, ProcessEnv } from "./system.js";

export type DeviceToolName = DeviceTool["name"];

interface Lockfile {
  packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
}

/**
 * The pinned tools. Each installs from its lockfile, so the whole dependency tree is pinned with integrity hashes;
 * the version OpenOrc asks for is the one its lockfile resolves.
 */
const specs: Record<DeviceToolName, { lock: Lockfile; entry: string[] }> = {
  "expo-device-hub": { lock: hubLock, entry: ["dist", "server", "cli.mjs"] },
  "agent-device": { lock: agentDeviceLock, entry: ["bin", "agent-device.mjs"] },
};

export function pinnedVersion(name: DeviceToolName): string {
  return specs[name].lock.packages[`node_modules/${name}`]!.version!;
}

/** The user's own Node.js and npm, from the login shell's PATH. */
export interface DeviceRuntime {
  node: string;
  npm: string;
  env: ProcessEnv;
}

export type RuntimeCheck = { ok: true; runtime: DeviceRuntime } | { ok: false; blocked: string };

const NODE_REQUIRED = "Device support needs Node.js 22.12 or later.";

/** Release builds cannot run Electron as Node, so both tools run on the Node.js the user's shell finds. */
export async function resolveRuntime(snapshot: EnvSnapshot, system: DeviceSystem): Promise<RuntimeCheck> {
  const node = await resolveBinary("node", snapshot.path);
  if (!node) return { ok: false, blocked: NODE_REQUIRED };
  const version = await system.run(node, ["--version"], { env: snapshot.env, timeoutMs: 10_000 });
  if (version.code !== 0 || !supportedNode(version.stdout)) return { ok: false, blocked: NODE_REQUIRED };
  const npm = await resolveBinary("npm", snapshot.path);
  if (!npm) return { ok: false, blocked: "Device support needs npm, which comes with Node.js." };
  return { ok: true, runtime: { node, npm, env: snapshot.env } };
}

function supportedNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 22 || (major === 22 && minor >= 12);
}

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const SENTINEL = ".install-complete";

/**
 * The tools in `<root>/tools/<package>/<version>`. An install is staged next to its target and renamed into place
 * only once npm finished and the entry file exists, so a crash mid-install leaves nothing that looks installed.
 */
export class DeviceToolchain {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly system: DeviceSystem,
  ) {}

  entry(name: DeviceToolName, version = pinnedVersion(name)): string {
    return path.join(this.root, "tools", name, version, "node_modules", name, ...specs[name].entry);
  }

  async status(): Promise<DeviceTool[]> {
    return Promise.all((Object.keys(specs) as DeviceToolName[]).map(async (name) => ({ name, pinned: pinnedVersion(name), installed: await this.installed(name) })));
  }

  /** The pinned version when it is installed, else the newest other complete install, else null. */
  async installed(name: DeviceToolName): Promise<string | null> {
    const versions = await readdir(path.join(this.root, "tools", name)).catch(() => [] as string[]);
    const complete: string[] = [];
    for (const version of versions) if (!version.startsWith(".") && (await this.complete(name, version))) complete.push(version);
    if (complete.includes(pinnedVersion(name))) return pinnedVersion(name);
    return complete.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ?? null;
  }

  /** Installs the pinned version unless it is already there. One install runs at a time. Resolves to the entry file. */
  ensureInstalled(name: DeviceToolName, runtime: DeviceRuntime): Promise<string> {
    const next = this.queue.then(() => this.install(name, runtime));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async complete(name: DeviceToolName, version: string): Promise<boolean> {
    const sentinel = await readFile(path.join(this.root, "tools", name, version, SENTINEL), "utf8").catch(() => null);
    return sentinel?.trim() === version && (await exists(this.entry(name, version)));
  }

  private async install(name: DeviceToolName, runtime: DeviceRuntime): Promise<string> {
    const version = pinnedVersion(name);
    if (await this.complete(name, version)) return this.entry(name);
    const parent = path.join(this.root, "tools", name);
    const target = path.join(parent, version);
    await rm(target, { recursive: true, force: true });
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(path.join(parent, ".staging-"));
    try {
      const { lock } = specs[name];
      await writeFile(path.join(staging, "package.json"), JSON.stringify({ private: true, dependencies: lock.packages[""]!.dependencies }, null, 2));
      await writeFile(path.join(staging, "package-lock.json"), JSON.stringify(lock, null, 2));
      const result = await this.system.run(runtime.npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
        cwd: staging,
        env: { ...runtime.env, npm_config_update_notifier: "false" },
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      // npm's output can carry registry credentials, so only its exit code is reported.
      if (result.timedOut) throw new Error(`Installing ${name} timed out.`);
      if (result.code !== 0) throw new Error(`Installing ${name} failed: npm exited with code ${result.code ?? "unknown"}.`);
      if (!(await exists(path.join(staging, "node_modules", name, ...specs[name].entry)))) throw new Error(`Installing ${name} left no ${specs[name].entry.join("/")}.`);
      await writeFile(path.join(staging, SENTINEL), `${version}\n`);
      await rename(staging, target);
      return this.entry(name);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}
