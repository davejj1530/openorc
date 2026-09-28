// Per-palette color overrides. A palette is the template; these are the edits
// a user makes on top of it. Light and dark hold separate values, so switching
// appearance never shows a color picked for the other mode.
import { themePresets, type Mode, type ThemePreset } from "./theme-palettes";

export type TokenOverrides = Record<string, string>;
export type CustomColors = Partial<Record<ThemePreset, Partial<Record<Mode, TokenOverrides>>>>;

export const colorGroups = [
  {
    name: "Mascot",
    tokens: [
      { token: "--mascot-body", label: "Mascot body" },
      { token: "--mascot-eyes", label: "Mascot eyes" },
    ],
  },
  {
    name: "Surfaces",
    tokens: [
      { token: "--bg", label: "Sidebar" },
      { token: "--surface", label: "Background" },
      { token: "--surface-2", label: "Raised" },
      { token: "--surface-3", label: "Hover" },
      { token: "--bubble", label: "Message bubble" },
      { token: "--bubble-ink", label: "Message bubble text" },
    ],
  },
  {
    name: "Text and lines",
    tokens: [
      { token: "--ink", label: "Text" },
      { token: "--ink-2", label: "Secondary text" },
      { token: "--ink-3", label: "Muted text" },
      { token: "--ink-4", label: "Faint text" },
      { token: "--line", label: "Border" },
      { token: "--line-strong", label: "Strong border" },
    ],
  },
  {
    name: "Accent",
    tokens: [
      { token: "--accent", label: "Accent" },
      { token: "--accent-ink", label: "Accent text" },
      { token: "--accent-fg", label: "On accent" },
      { token: "--accent-soft", label: "Accent tint" },
      { token: "--selection", label: "Selection" },
    ],
  },
] satisfies { name: string; tokens: { token: string; label: string }[] }[];

export const editableTokens = colorGroups.flatMap((group) => group.tokens.map((entry) => entry.token));
const editable = new Set<string>(editableTokens);
const presetIds = new Set<string>(themePresets.map((preset) => preset.id));

/** Accepts `#abc`, `abc`, `#AABBCC` and returns the canonical `#aabbcc`, or null. */
export function normalizeHex(value: string): string | null {
  const digits = value.trim().replace(/^#/, "").toLowerCase();
  const expanded = digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits;
  return /^[0-9a-f]{6}$/.test(expanded) ? `#${expanded}` : null;
}

export function overridesFor(custom: CustomColors, preset: ThemePreset, mode: Mode): TokenOverrides {
  return custom[preset]?.[mode] ?? {};
}

function replace(custom: CustomColors, preset: ThemePreset, mode: Mode, overrides: TokenOverrides): CustomColors {
  const modes = { ...custom[preset], [mode]: overrides };
  if (Object.keys(overrides).length === 0) delete modes[mode];
  const next = { ...custom, [preset]: modes };
  if (Object.keys(modes).length === 0) delete next[preset];
  return next;
}

export function withColor(custom: CustomColors, preset: ThemePreset, mode: Mode, token: string, value: string): CustomColors {
  const hex = normalizeHex(value);
  if (!hex || !editable.has(token)) return custom;
  return replace(custom, preset, mode, { ...overridesFor(custom, preset, mode), [token]: hex });
}

export function withoutColor(custom: CustomColors, preset: ThemePreset, mode: Mode, token: string): CustomColors {
  const overrides = { ...overridesFor(custom, preset, mode) };
  if (!(token in overrides)) return custom;
  delete overrides[token];
  return replace(custom, preset, mode, overrides);
}

export function withoutOverrides(custom: CustomColors, preset: ThemePreset, mode: Mode): CustomColors {
  return Object.keys(overridesFor(custom, preset, mode)).length === 0 ? custom : replace(custom, preset, mode, {});
}

/** Drops anything a past version, a hand edit, or another tab may have left behind. */
export function parseCustomColors(raw: string | null): CustomColors {
  let parsed: unknown;
  try {
    parsed = raw === null ? null : JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object") return {};
  let custom: CustomColors = {};
  for (const [preset, modes] of Object.entries(parsed as Record<string, unknown>)) {
    if (!presetIds.has(preset) || modes === null || typeof modes !== "object") continue;
    for (const [mode, overrides] of Object.entries(modes as Record<string, unknown>)) {
      if ((mode !== "light" && mode !== "dark") || overrides === null || typeof overrides !== "object") continue;
      for (const [token, value] of Object.entries(overrides as Record<string, unknown>)) {
        if (typeof value === "string") custom = withColor(custom, preset as ThemePreset, mode, token, value);
      }
    }
  }
  return custom;
}
