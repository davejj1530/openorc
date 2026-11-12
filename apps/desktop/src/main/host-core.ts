import { mkdirSync } from "node:fs";
import path from "node:path";
import type { MessagePortMain } from "electron";
import type { HostChoice } from "../shared/host";
import { distroPaths, useHostPaths } from "./host";
import { WslCore } from "./wsl/core";
import { standInDistro, wslDistro, type Distro } from "./wsl/distro";
import { listDistros, type WslDistroInfo } from "./wsl/distros";
import { startWslCore } from "./wsl/start";

/**
 * A core as main holds it, wherever it runs: Electron's utility process on this computer, or the relay to a core
 * inside a WSL distribution. Everything main installs on a core is written against this.
 */
export interface CoreProcess {
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  removeListener(event: "message", listener: (message: unknown) => void): unknown;
  removeListener(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: unknown): void;
  kill(): boolean;
}

/**
 * Hands the core one window: its channel, and the one device video comes on. A utility process takes the ports
 * themselves and main steps out of the way; a core inside a distribution has main relay them.
 */
export function connectWindow(core: CoreProcess, rpc: MessagePortMain, media: MessagePortMain): void {
  if (core instanceof WslCore) core.connect(rpc, media);
  else (core as { postMessage(message: unknown, transfer: MessagePortMain[]): void }).postMessage({ type: "port" }, [rpc, media]);
}

/**
 * This machine standing in for a distribution, named by OPENORC_WSL_STANDIN: development and QA builds only, so the
 * whole WSL route can run where there is no wsl.exe. OPENORC_WSL_STANDIN_HOME gives it a home of its own.
 */
function standIn(qa: boolean, env: NodeJS.ProcessEnv): { name: string; distro: () => Distro } | null {
  const name = qa ? env["OPENORC_WSL_STANDIN"] : undefined;
  if (!name || !/^[\w.-]{1,128}$/.test(name)) return null;
  const home = env["OPENORC_WSL_STANDIN_HOME"];
  return { name, distro: () => standInDistro(name, home ? { ...env, HOME: home } : env) };
}

export interface HostCores {
  /** Where the core runs: what was chosen, when this computer can do it; else this computer. */
  choice(chosen: HostChoice): HostChoice;
  /** The distributions the app offers to run in. */
  distros(): Promise<WslDistroInfo[]>;
  /** Starts the core inside a distribution and points main's paths at it. */
  start(name: string): WslCore;
  /** The folder main keeps a place's protected secrets in, made if it is missing. */
  secretsDir(host: HostChoice): string;
  /** The home folder inside the distribution the core runs in, once known. */
  home(): string | null;
}

export function hostCores(input: {
  userData: string;
  /** The folder the app carries the core for WSL in, and the one it carries the cloud brain in. */
  coreDir: string;
  brainDir: string | null;
  fileKey: string;
  qa: boolean;
  fetchNode(url: string): Promise<Buffer>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): HostCores {
  const platform = input.platform ?? process.platform;
  const stand = standIn(input.qa, input.env ?? process.env);
  let profile: string | null = null;
  return {
    choice(chosen) {
      if (chosen.kind !== "wsl") return chosen;
      // A choice carried to a computer that cannot honour it, such as a profile copied off Windows, reads as this computer.
      return platform === "win32" || stand?.name === chosen.distro ? chosen : { kind: "local" };
    },
    distros: async () => (stand ? [{ name: stand.name, default: true, version: null }] : listDistros(platform)),
    start(name) {
      const distro = stand?.name === name ? stand.distro() : wslDistro(name);
      profile = null;
      useHostPaths(distroPaths(distro, () => profile, path.join(input.userData, "wsl", "not-started")));
      return startWslCore({
        distro,
        coreDir: input.coreDir,
        brainDir: input.brainDir,
        fileKey: input.fileKey,
        qa: input.qa,
        fetchNode: input.fetchNode,
        profile: (dataDir) => (profile = dataDir),
      });
    },
    secretsDir(host) {
      if (host.kind === "local") return input.userData;
      // Each distribution's secrets are its own: they stay on the Windows side, encrypted for this Windows account.
      const dir = path.join(input.userData, "wsl", host.distro.toLowerCase());
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    // The profile sits two folders under the home: ~/.openorc-wsl/data.
    home: () => (profile ? path.posix.dirname(path.posix.dirname(profile)) : null),
  };
}
