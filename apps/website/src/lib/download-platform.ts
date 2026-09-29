import type { InstallerTarget } from "../data/downloads";

interface ClientHints {
  platform?: string;
  mobile?: boolean;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }>;
}
export interface DownloadNavigator {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  userAgentData?: ClientHints;
}
export interface DownloadDevice {
  platform: "mac" | "windows" | "linux" | "mobile" | "other";
  target: InstallerTarget | null;
}

function downloadPlatform(nav: DownloadNavigator): DownloadDevice["platform"] {
  const ua = nav.userAgent;
  if (nav.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(nav.platform) && nav.maxTouchPoints > 1)) return "mobile";
  const platform = nav.userAgentData?.platform || nav.platform || ua;
  if (/Mac/i.test(platform)) return "mac";
  if (/Win/i.test(platform)) return "windows";
  // ChromeOS reports Linux too, but installs neither package.
  if (/Linux/i.test(platform) && !/CrOS/i.test(ua)) return "linux";
  return "other";
}

/** The Linux packages are x64 only. Some Linux browsers name their distribution; the rest leave the choice to the visitor. */
function linuxPackage(ua: string, hints?: { architecture?: string; bitness?: string }): InstallerTarget | null {
  const x64 = (hints?.architecture === "x86" && hints.bitness === "64") || /x86_64|amd64/i.test(ua);
  if (hints?.architecture === "arm" || hints?.bitness === "32" || !x64) return null;
  if (/Fedora|openSUSE|SUSE|Red Hat/i.test(ua)) return "linux-rpm";
  if (/Ubuntu|Debian|Mint/i.test(ua)) return "linux-deb";
  return null;
}

export function downloadDevice(nav: DownloadNavigator, hints?: { architecture?: string; bitness?: string }): DownloadDevice {
  const platform = downloadPlatform(nav);
  if (platform === "mac") {
    if (hints?.architecture === "arm" && hints.bitness === "64") return { platform: "mac", target: "mac-arm64" };
    if (hints?.architecture === "x86" && hints.bitness === "64") return { platform: "mac", target: "mac-x64" };
    // Apple Silicon browsers can report MacIntel / Intel Mac OS X. Never infer
    // a Mac's chip from the legacy UA string or fingerprint the GPU to guess it.
    return { platform: "mac", target: null };
  }
  if (platform === "windows") {
    if (hints?.architecture === "arm" || hints?.bitness === "32" || /ARM|aarch64/i.test(nav.userAgent)) return { platform, target: null };
    const x64 = hints?.architecture === "x86" && hints.bitness === "64";
    return { platform, target: x64 || /Win64|WOW64|Windows.*x64/i.test(nav.userAgent) ? "win-x64" : null };
  }
  if (platform === "linux") return { platform, target: linuxPackage(nav.userAgent, hints) };
  return { platform, target: null };
}

/** Enhancement only: denied or unavailable hints leave the manual choices usable. */
export async function detectDownloadDevice(nav: DownloadNavigator): Promise<DownloadDevice> {
  const fallback = downloadDevice(nav);
  if (!["mac", "windows", "linux"].includes(fallback.platform) || !nav.userAgentData?.getHighEntropyValues) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const hints = await Promise.race([
      nav.userAgentData.getHighEntropyValues(["architecture", "bitness"]),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 500);
      }),
    ]);
    return downloadDevice(nav, hints);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
