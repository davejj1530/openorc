import { execFile } from "node:child_process";
import { decodeWslText, wslExe } from "./distro";

export interface WslDistroInfo {
  name: string;
  /** The one a bare `wsl` starts. */
  default: boolean;
  /** WSL 1 or 2, when wsl.exe said. */
  version: 1 | 2 | null;
}

/** Distributions other tools keep for themselves: no one's folders live there. */
const UTILITY = /^(docker-desktop|rancher-desktop|podman-machine)/i;

/**
 * The distributions two listings name. `quiet` is names alone, one a line, in every language; `verbose` has a row for
 * each with a star before the default and the WSL version last, under a heading and state words that are translated,
 * so a row is found by its name and nothing else of it is read.
 */
export function parseDistros(quiet: string, verbose: string): WslDistroInfo[] {
  const rows = verbose.split("\n").map((line) => ({ starred: line.trimStart().startsWith("*"), words: line.replace("*", " ").trim().split(/\s+/) }));
  return quiet
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name && !UTILITY.test(name))
    .map((name) => {
      const row = rows.find(({ words }) => words[0] === name);
      const version = Number(row?.words.at(-1));
      return { name, default: row?.starred ?? false, version: version === 1 || version === 2 ? version : null };
    });
}

type RunWsl = (args: string[]) => Promise<Buffer>;

const runWsl: RunWsl = (args) =>
  new Promise((resolve, reject) => {
    execFile(wslExe(), args, { encoding: "buffer", timeout: 15_000, windowsHide: true, env: { ...process.env, WSL_UTF8: "1" } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

/**
 * The distributions installed on this PC, the default first. Empty anywhere but Windows, and on a PC with no WSL or
 * none installed, where wsl.exe is missing or answers with an error.
 */
export async function listDistros(platform: NodeJS.Platform = process.platform, run: RunWsl = runWsl): Promise<WslDistroInfo[]> {
  if (platform !== "win32") return [];
  try {
    const quiet = decodeWslText(await run(["--list", "--quiet"]));
    // Older builds of wsl.exe have no --verbose; the names alone are enough to offer them.
    const verbose = await run(["--list", "--verbose"]).then(decodeWslText, () => "");
    return parseDistros(quiet, verbose).sort((a, b) => Number(b.default) - Number(a.default));
  } catch {
    return [];
  }
}
