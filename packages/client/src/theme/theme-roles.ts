// The roles every built-in palette fills: the neutral ramp, the derived defaults, and the status colours.
import type { Mode } from "./theme-palettes.js";

// Source colors map to shell roles, not a house tint or contrast ladder.
// Every palette has the same structure: the window ground (--bg, the conversation and the panel; the sidebar's
// --sidebar follows it unless a palette tints it), planes one step off it (--surface: sheets, cards, menus), pieces
// set into it (--well: the composer, transcript cards, Settings tiles), then the fills. Code and diffs in the panel sit
// on --paper, the planes' own colour unless a palette gives its work panels their own.
// Product presets keep flat paint (no gradient); palettes whose source is one flat light color
// get a hand-tuned ground step. See docs/theme-references.md for sources and adaptations.
// Readable supporting text may use the next stronger source role.
const neutralTokens = {
  sidebar: "bg",
  body: "surface",
  raised: "surface-2",
  hover: "surface-3",
  border: "line",
  borderStrong: "line-strong",
  text: "ink",
  secondaryText: "ink-2",
  mutedText: "ink-3",
  faintText: "ink-4",
  bubble: "bubble",
} as const;
type Neutrals = Record<keyof typeof neutralTokens, string>;
export function palette(neutrals: Neutrals, accent: string, accentInk: string, accentForeground: string, overrides: Record<string, string> = {}) {
  return {
    ...Object.fromEntries(Object.entries(neutralTokens).map(([role, token]) => [`--${token}`, neutrals[role as keyof Neutrals]])),
    "--paper": "var(--surface)",
    // The sidebar's own ground, the window's unless a palette tints it.
    "--sidebar": "var(--bg)",
    // A sidebar row under the pointer.
    "--navigation-hover": "var(--surface-2)",
    // What lifts a raised plane (the composer, cards, the open tab, menus) off a ground it barely steps from. Palettes
    // whose planes step clearly off their ground keep an empty shadow; it stays a shadow so a rule can add its own.
    "--raised-shadow": "0 0 #0000",
    // The agent's reading text. Headings and bold lead-ins stay in --ink.
    "--prose-ink": "var(--ink)",
    // A diff's line numbers.
    "--line-number": "var(--ink-4)",
    // Light as an accent: the open row (--lit), the one primary pill and a ready send button (--lit-strong), and the
    // filter on a working thread's cube (--lit-mark) in --working-ink. Palettes that do not light them stay flat.
    "--lit": "0 0 #0000",
    "--lit-strong": "0 0 #0000",
    "--lit-mark": "none",
    "--working-ink": "var(--ink-3)",
    "--accent": accent,
    "--accent-ink": accentInk,
    "--accent-fg": accentForeground,
    "--navigation-accent": accentInk,
    "--navigation-soft": "",
    "--content-accent": accentInk,
    "--accent-soft": `color-mix(in srgb, ${accentInk} 14%, ${neutrals.body})`,
    "--selection": `color-mix(in srgb, ${accentInk} 26%, ${neutrals.body})`,
    // The house mascot is ink on the ground; brand palettes give it their own color below.
    "--mascot-body": /^#[0-9a-f]{8}$/i.test(neutrals.text) ? neutrals.text.slice(0, 7) : neutrals.text,
    "--mascot-eyes": neutrals.body,
    "--bubble-ink": neutrals.text,
    ...overrides,
  };
}
// Status: --ok for +N counts, checks and diff additions; --warn for waiting, approvals and warning
// text; --bad for failures and diff removals; --attention for status dots, which default to --warn.
// Every palette starts from these and changes only the ones it names. The soft fills tint their
// ink unless a palette paints them. Switching palettes only sets properties, never clears them,
// so every palette carries every key.
const statusSoft = {
  "--ok-soft": "color-mix(in srgb, var(--ok) 8%, var(--surface))",
  "--warn-soft": "color-mix(in srgb, var(--warn) 8%, var(--surface))",
  "--bad-soft": "color-mix(in srgb, var(--bad) 8%, var(--surface))",
  "--attention": "var(--warn)",
};
export const statusTokens: Record<Mode, Record<string, string>> = {
  light: { "--ok": "#157447", "--warn": "#8b5c0a", "--bad": "#aa4538", ...statusSoft },
  dark: { "--ok": "#3fae74", "--warn": "#c0973a", "--bad": "#e27d6f", ...statusSoft },
};
