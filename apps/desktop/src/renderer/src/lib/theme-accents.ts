import { accentHex, accentPair, mixColor, onColor } from "./accent-colors";
import type { Mode } from "./theme-palettes";

export const accentRoles = [
  { token: "--accent", label: "Actions", description: "Primary buttons and focus" },
  { token: "--navigation-accent", label: "Navigation", description: "Active views, threads, and filters" },
  { token: "--content-accent", label: "Content", description: "Links, inline code, and conversation markers" },
] as const;
export type AccentToken = (typeof accentRoles)[number]["token"];

// A role can use its own hue. Omitted roles continue following the palette's action accent.
export const accentTokens = ["--accent", "--accent-ink", "--accent-fg", "--accent-soft", "--selection", "--navigation-accent", "--content-accent"];
export const accentCombinations = [
  { id: "rose-sage", name: "Rose & sage", light: ["#b64e48", "#497463", "#87613f"], dark: ["#c76660", "#8cbaa5", "#d9ad80"] },
  { id: "ocean", name: "Ocean", light: ["#2768a5", "#397773", "#535caa"], dark: ["#5799da", "#7cbbb4", "#a6aaf0"] },
  { id: "plum", name: "Plum & amber", light: ["#86518a", "#726098", "#926019"], dark: ["#b885be", "#b6a3dc", "#deb46c"] },
  { id: "graphite", name: "Graphite", light: ["#4d545a", "#4d545a", "#4d545a"], dark: ["#aeb5bb", "#aeb5bb", "#aeb5bb"] },
] satisfies { id: string; name: string; light: [string, string, string]; dark: [string, string, string] }[];
export type AccentCombination = (typeof accentCombinations)[number]["id"];

export function combinationColors(id: AccentCombination, mode: Mode): Record<string, string> {
  const colors = accentCombinations.find((entry) => entry.id === id)![mode];
  return { "--accent": colors[0], "--navigation-accent": colors[1], "--content-accent": colors[2] };
}

/** Keep old fine-grained overrides, deriving companions when a user picks a new action color. */
export function resolveAccentColors(base: Record<string, string>, overrides: Record<string, string>): Record<string, string> {
  const colors = { ...base, ...overrides };
  const surface = accentHex(colors["--surface"]);
  const action = accentHex(colors["--accent"]);
  if (overrides["--accent"]) {
    const pair = accentPair(action, surface);
    colors["--accent-ink"] = overrides["--accent-ink"] ?? pair.ink;
    colors["--accent-soft"] = overrides["--accent-soft"] ?? pair.soft;
    colors["--accent-fg"] = overrides["--accent-fg"] ?? onColor(action);
  }
  for (const role of ["navigation", "content"]) {
    const custom = overrides[`--${role}-accent`];
    const ground = role === "navigation" ? accentHex(colors["--bg"]) : surface;
    const pair = custom ? accentPair(custom, ground) : { ink: colors["--accent-ink"] ?? action, soft: colors["--accent-soft"] ?? surface };
    colors[`--${role}-accent`] = custom ?? action;
    colors[`--${role}-ink`] = pair.ink;
    colors[`--${role}-soft`] = pair.soft;
  }
  if (overrides["--accent"] || overrides["--content-accent"]) {
    colors["--selection"] = overrides["--selection"] ?? mixColor(accentHex(colors["--content-ink"]), surface, 0.26);
  }
  return colors;
}
