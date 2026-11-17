/**
 * Whether an app is due the steps on what a release brought: once, after updating to `release` or a later version,
 * for a profile that ran an earlier one, and never for a fresh install, whose onboarding comes first.
 */

type Version = { core: [number, number, number]; beta: number | null };

/** A release version, "1.2.3" or "1.2.3-beta.4"; anything else is none. */
function parse(version: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(version);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], beta: match[4] === undefined ? null : Number(match[4]) };
}

/** Negative when `a` came before `b`, positive after, zero for the same release; a beta comes before its release. */
export function compareVersions(a: string, b: string): number | null {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i]! - right.core[i]!;
  if (left.beta === right.beta) return 0;
  if (left.beta === null) return 1;
  if (right.beta === null) return -1;
  return left.beta - right.beta;
}

/**
 * `release`: the first version with what the steps show. `running`: this app's version. `seen`: the last version this profile settled the steps for, or null for a profile
 * that never did, which ran a version from before they existed if it finished onboarding (`onboarded`).
 */
export function whatsNewDue({ release, running, seen, onboarded }: { release: string; running: string; seen: string | null; onboarded: boolean }): boolean {
  const brings = compareVersions(running, release);
  if (brings === null || brings < 0) return false;
  if (seen === null) return onboarded;
  const before = compareVersions(seen, release);
  return before !== null && before < 0;
}
