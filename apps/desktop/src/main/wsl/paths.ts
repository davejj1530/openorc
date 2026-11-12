import path from "node:path";

/**
 * A distribution's files as Windows names them: `\\wsl$\Ubuntu\home\me`, and on newer Windows also
 * `\\wsl.localhost\Ubuntu\...`, which is what its folder chooser hands back. The core inside a distribution speaks only
 * its own paths, so every path that crosses between it and main, a folder the user chose or a file main is asked to
 * open, is translated here.
 */

/** Read either way. Written the first way, which every Windows that has WSL understands. */
const ROOTS = ["\\\\wsl$\\", "\\\\wsl.localhost\\"];

/**
 * Characters a Linux name may hold and a Windows name may not. Windows shows each as a private-use character, the
 * same one for a name read through the share as for one read through a mounted drive, and takes it back the same way.
 */
const WINDOWS_ILLEGAL = new Set('<>:"\\|?*');
const PRIVATE_USE = /[\uf001-\uf07f]/g;
const PRIVATE_BASE = 0xf000;

const illegal = (char: string) => WINDOWS_ILLEGAL.has(char) || char.charCodeAt(0) < 0x20;
const toWindowsName = (name: string) => Array.from(name, (char) => (illegal(char) ? String.fromCharCode(PRIVATE_BASE + char.charCodeAt(0)) : char)).join("");
const toLinuxName = (name: string) => name.replace(PRIVATE_USE, (char) => String.fromCharCode(char.charCodeAt(0) - PRIVATE_BASE));

/** The distribution a Windows path is inside and the path there, or null for a path anywhere else. */
export function parseWslPath(windowsPath: string): { distro: string; path: string } | null {
  const normal = windowsPath.replace(/\//g, "\\");
  const root = ROOTS.find((prefix) => normal.toLowerCase().startsWith(prefix));
  if (!root) return null;
  const [distro, ...parts] = normal.slice(root.length).split("\\");
  if (!distro) return null;
  return { distro, path: path.posix.normalize(`/${parts.filter(Boolean).map(toLinuxName).join("/")}`) };
}

/** Distribution names match as Windows matches them: without regard to case. */
export const sameDistro = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface WslPaths {
  /** The Windows path of a path inside the distribution. */
  toWindows(linuxPath: string): string;
  /** The path inside the distribution of a Windows path, or null when it names nothing inside it. */
  toLinux(windowsPath: string): string | null;
}

export function wslPaths(distro: string, root = ROOTS[0]!): WslPaths {
  return {
    toWindows(linuxPath) {
      const parts = path.posix.normalize(`/${linuxPath}`).split("/").filter(Boolean);
      return `${root}${distro}${parts.map((part) => `\\${toWindowsName(part)}`).join("") || "\\"}`;
    },
    toLinux(windowsPath) {
      const parsed = parseWslPath(windowsPath);
      return parsed && sameDistro(parsed.distro, distro) ? parsed.path : null;
    },
  };
}
