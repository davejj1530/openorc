import type { ChangelogRelease } from "./changelog";
import type { ReleaseAsset } from "./release-assets";

export const installerTargets = [
  { id: "mac-arm64", title: "macOS", chip: "Apple Silicon", detail: "For Macs with an M-series chip", extension: "dmg" },
  { id: "mac-x64", title: "macOS", chip: "Intel", detail: "For Macs with an Intel processor", extension: "dmg" },
  { id: "win-x64", title: "Windows", chip: "64-bit", detail: "For Windows on Intel or AMD processors", extension: "exe" },
] as const;
export type InstallerTarget = (typeof installerTargets)[number]["id"];
export interface Installer extends ReleaseAsset {
  target: InstallerTarget;
  unsigned: boolean;
}
export interface DownloadRelease {
  tag: string;
  url: string;
  prerelease: boolean;
  installers: Installer[];
}

/** Prefer stable once available; public betas remain downloadable before 1.0. */
export function selectDownloadRelease(releases: ChangelogRelease[]): DownloadRelease | null {
  const candidates = [...releases]
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .flatMap((release) => {
      if (!/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(release.tag)) return [];
      const installers = installerTargets.flatMap((target): Installer[] => {
        const base = `OpenOrc-${release.tag.slice(1)}-${target.id}`;
        const signed = release.assets.find((asset) => asset.name === `${base}.${target.extension}`);
        const unsigned = target.id === "win-x64" && release.prerelease ? release.assets.find((asset) => asset.name === `${base}-unsigned.exe`) : undefined;
        const asset = signed ?? unsigned;
        return asset ? [{ ...asset, target: target.id, unsigned: asset === unsigned }] : [];
      });
      return installers.length ? [{ tag: release.tag, url: release.url, prerelease: release.prerelease, installers }] : [];
    });
  return candidates.find((release) => !release.prerelease) ?? candidates[0] ?? null;
}
