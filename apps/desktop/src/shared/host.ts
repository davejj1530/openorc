/** Where the app's core runs: this computer, or a WSL distribution on Windows. */
export type HostChoice = { kind: "local" } | { kind: "wsl"; distro: string };

/** What the window is told about where the core runs and where else it could. */
export interface HostState {
  current: HostChoice;
  /** The distributions installed on this PC, the default first. Empty anywhere but Windows, and on a PC without WSL. */
  distros: { name: string; default: boolean }[];
}

/** The answer to a request to run somewhere else: done, or why not, in words for the person who asked. */
export type HostSwitch = { ok: true } | { ok: false; reason: string };

export const sameHost = (a: HostChoice, b: HostChoice): boolean => a.kind === b.kind && (a.kind === "local" || (b.kind === "wsl" && a.distro.toLowerCase() === b.distro.toLowerCase()));

/** What the app calls the machine it runs on, for the middle of a sentence: "this PC". */
export const thisComputer = (platform: string): string => COMPUTERS[platform] ?? "this computer";
const COMPUTERS: Record<string, string> = { win32: "this PC", darwin: "this Mac" };

/** How a place is named where the app says where it runs: "WSL: Ubuntu". */
export const hostName = (host: HostChoice, thisComputer: string): string => (host.kind === "wsl" ? `WSL: ${host.distro}` : thisComputer);
