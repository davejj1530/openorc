// Built-in palettes. A preset named after a product adapts that product's UI colors to the
// shell's roles and follows the rules below, so its values are not exact copies.
export type ThemePreset = "openorc" | "codex" | "conductor" | "linear" | "cursor" | "claude" | "github" | "halcyon" | "kamakura" | "clickup" | "cyberpunk" | "notion" | "eliron";
export type Mode = "light" | "dark";
export interface ThemeTemplate {
  id: ThemePreset;
  name: string;
  description: string;
  colors: Record<Mode, Record<string, string>>;
}
// Existing shell classes use bg-bg for navigation and bg-surface for content.
// User-directed grounds: sidebar and body share one tone (or sit within a step of each other),
// and every other neutral climbs in small steps, so raised surfaces read through their lit edge
// rather than through a large fill jump. Each brand keeps its own ground: white for OpenOrc,
// Codex and GitHub light, cream for Claude, graphite for Cursor, slate for GitHub dark.
//
// Neutral relationships every palette holds, so the shell reads the same way throughout:
//   raised sits clear of body and of sidebar, because rows hover on both. In light it keeps
//     the distance below the body the palette had before the grounds went white.
//   border returns to the palette's own researched value, because a visible border is part of
//     what makes GitHub read as GitHub and a near-invisible one is part of what makes Linear
//     read as Linear. Identity wins over the house quiet-structure default, with one cap: a
//     hairline may travel at most 0.30 of the ground-to-ink-3 distance, so it never competes
//     with text. Only GitHub dark hit that cap.
//   mutedText (ink-3) is supporting copy at 4.5:1 on body; faintText (ink-4) is metadata
//   and placeholders at 3:1. They are separate jobs and never share a value.
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
function palette(neutrals: Neutrals, accent: string, accentInk: string, accentForeground: string, overrides: Record<string, string> = {}) {
  return {
    ...Object.fromEntries(Object.entries(neutralTokens).map(([role, token]) => [`--${token}`, neutrals[role as keyof Neutrals]])),
    "--accent": accent,
    "--accent-ink": accentInk,
    "--accent-fg": accentForeground,
    "--accent-soft": `color-mix(in srgb, ${accentInk} 14%, ${neutrals.body})`,
    "--selection": `color-mix(in srgb, ${accentInk} 26%, ${neutrals.body})`,
    // The house mascot is ink on the ground; brand palettes give it their own color below.
    "--mascot-body": /^#[0-9a-f]{8}$/i.test(neutrals.text) ? neutrals.text.slice(0, 7) : neutrals.text,
    "--mascot-eyes": neutrals.body,
    "--bubble-ink": neutrals.text,
    // Light planes stay flat: their raised steps sit below the ground, so a fall-off would bury them.
    "--surface-gradient": "none",
    ...overrides,
  };
}
// Dark work planes fall off like Linear's agent view: the palette's lighter ground at the top and a
// darker one at the bottom, 3 to 4.5 L* apart. Raised and hover fills already sit clear of both
// grounds, so the lit top costs them nothing and the darker bottom only widens their contrast. Both
// ends read the live tokens, so edited Background and Sidebar colors carry into the fade.
// Where the body sits above the sidebar (OpenOrc, Halcyon), the plane fades into the sidebar.
const fadeIntoSidebar = "linear-gradient(var(--surface), var(--bg))";
// Where it sits below, the plane starts at the sidebar's tone and ends a notch under its own,
// because those two grounds are only a step or two apart.
const fadeFromSidebar = "linear-gradient(var(--bg), oklch(from var(--surface) calc(l - 0.02) c h))";
// Success and attention: +N counts, checks and diff additions; waiting, approvals and warnings.
// Every palette starts from the shell's own, the values app.css declares before a palette loads,
// and changes only the ones it names. The soft fills tint their ink unless a palette paints them.
// Switching palettes only sets properties, never clears them, so every palette carries every key.
const statusSoft = { "--ok-soft": "color-mix(in srgb, var(--ok) 8%, var(--surface))", "--warn-soft": "color-mix(in srgb, var(--warn) 8%, var(--surface))" };
const statusTokens: Record<Mode, Record<string, string>> = {
  light: { "--ok": "#157447", "--warn": "#8b5c0a", ...statusSoft },
  dark: { "--ok": "#22975d", "--warn": "#a47f29", ...statusSoft },
};
const presets: ThemeTemplate[] = [
  // OpenOrc's own palette. Dark is a Linear-style charcoal, a few steps lighter than Linear's,
  // whose work plane fades from its lit top into the sidebar's ground, as Linear's agent view
  // does. Light keeps the white ground and black bubble. Teal carries actions and links in both
  // modes, and the mascot is pink.
  {
    id: "openorc",
    name: "OpenOrc",
    description: "Charcoal gradient · teal",
    colors: {
      light: palette(
        {
          sidebar: "#ffffff",
          body: "#ffffff",
          raised: "#f5f5f5",
          hover: "#ececec",
          border: "#e8e8e8",
          borderStrong: "#d2d2d2",
          text: "#1d1d1f",
          secondaryText: "#484848",
          mutedText: "#626262",
          faintText: "#7a7a7a",
          bubble: "#000000",
        },
        "#008375",
        "#007b6e",
        "#ffffff",
        { "--bubble-ink": "#ffffff", "--mascot-body": "#df4b9d", "--mascot-eyes": "#ffffff" },
      ),
      dark: palette(
        {
          sidebar: "#141417",
          body: "#1c1c21",
          raised: "#24242a",
          hover: "#2c2c33",
          border: "#2a2a31",
          borderStrong: "#3a3a42",
          text: "#ececef",
          secondaryText: "#b8b8c0",
          mutedText: "#8e8e98",
          faintText: "#6e6e78",
          bubble: "#26262c",
        },
        "#008375",
        "#4ed7c5",
        "#ffffff",
        { "--mascot-body": "#f080b8", "--mascot-eyes": "#141417", "--surface-gradient": fadeIntoSidebar },
      ),
    },
  },
  // Solid blue controls keep white labels in both modes; the fill meets 4.5:1 contrast.
  {
    id: "codex",
    name: "Codex",
    description: "Neutral gray · clear blue",
    colors: {
      light: palette(
        {
          sidebar: "#ffffff",
          body: "#ffffff",
          raised: "#f7f7f7",
          hover: "#efefef",
          border: "#ebebeb",
          borderStrong: "#d6d6d6",
          text: "#0d0d0d",
          secondaryText: "#444444",
          mutedText: "#686868",
          faintText: "#878787",
          bubble: "#f4f4f4",
        },
        "#0169cc",
        "#0169cc",
        "#ffffff",
        { "--mascot-body": "#0169cc", "--mascot-eyes": "#ffffff" },
      ),
      dark: palette(
        {
          sidebar: "#181818",
          body: "#151515",
          raised: "#1e1e1e",
          hover: "#252525",
          border: "#2a2a2a",
          borderStrong: "#3d3d3d",
          text: "#e6e6e6",
          secondaryText: "#b5b5b5",
          mutedText: "#878787",
          faintText: "#707070",
          bubble: "#1d1d1d",
        },
        "#0875e1",
        "#339cff",
        "#ffffff",
        { "--mascot-body": "#339cff", "--mascot-eyes": "#151515", "--surface-gradient": fadeFromSidebar },
      ),
    },
  },
  // Conductor's copper-black ground, raised surface, text and lines sampled from the supplied
  // app screenshot. Copper stays in the accent; the reading surfaces are barely tinted.
  {
    id: "conductor",
    name: "Conductor",
    description: "Copper-black · soft warm neutrals",
    colors: {
      light: palette(
        {
          sidebar: "#faf8f7",
          body: "#faf8f7",
          raised: "#f1ece9",
          hover: "#e8e1dd",
          border: "#e3dcd8",
          borderStrong: "#c8bbb5",
          text: "#29231f",
          secondaryText: "#554941",
          mutedText: "#706159",
          faintText: "#87786f",
          bubble: "#efe8e4",
        },
        "#875c49",
        "#80523f",
        "#ffffff",
        { "--mascot-body": "#a2705c", "--mascot-eyes": "#ffffff" },
      ),
      dark: palette(
        {
          sidebar: "#141110",
          body: "#141110",
          raised: "#201d1c",
          hover: "#292523",
          border: "#2c2928",
          borderStrong: "#434140",
          text: "#eae8e6",
          secondaryText: "#a4a09d",
          mutedText: "#96918e",
          faintText: "#797573",
          bubble: "#201d1c",
        },
        "#b5826f",
        "#cc9b87",
        "#141110",
        { "--mascot-body": "#b5826f", "--mascot-eyes": "#141110", "--surface-gradient": fadeFromSidebar },
      ),
    },
  },
  {
    id: "linear",
    name: "Linear",
    description: "Neutral charcoal · indigo",
    colors: {
      light: palette(
        {
          sidebar: "lch(99% 0.5 282 / 1)",
          body: "lch(99% 0.5 282 / 1)",
          raised: "lch(96.5% 0.9 282 / 1)",
          hover: "lch(93.5% 1.1 282 / 1)",
          border: "lch(92.5% 0.6 282 / 1)",
          borderStrong: "lch(85.5% 1.2 282 / 1)",
          text: "lch(9.794% 0 282 / 1)",
          secondaryText: "lch(27.776% 1.25 282 / 1)",
          mutedText: "lch(42.961% 1.25 282 / 1)",
          faintText: "lch(55.318% 1.25 282 / 1)",
          bubble: "lch(95.5% 0.7 282 / 1)",
        },
        "lch(44.073% 70 286.91 / 1)",
        "lch(44.073% 70 286.91 / 1)",
        "lch(100% 5 286.91 / 1)",
        { "--mascot-body": "#5e6ad2", "--mascot-eyes": "#ffffff", "--accent-soft": "lch(92.254% 5.903 282.518 / 1)" },
      ),
      dark: palette(
        {
          sidebar: "lch(4.8% 0.5 272 / 1)",
          body: "lch(2.2% 0.5 272 / 1)",
          raised: "lch(7.8% 0.9 272 / 1)",
          hover: "lch(11.3% 1.1 272 / 1)",
          border: "lch(13.6% 1.48 272 / 1)",
          borderStrong: "lch(18.184% 1.5 272 / 1)",
          text: "lch(90.06% 0 272 / 1)",
          secondaryText: "lch(72.35% 1.2 272 / 1)",
          mutedText: "lch(54.951% 1.2 272 / 1)",
          faintText: "lch(42.638% 1.2 272 / 1)",
          bubble: "lch(7% 0.85 272 / 1)",
        },
        "lch(47.918% 59.303 288.421)",
        "lch(57.028% 70 288.421 / 1)",
        "lch(100% 5 288.421 / 1)",
        { "--mascot-body": "#828fff", "--mascot-eyes": "#0b0c10", "--accent-soft": "lch(12.141% 17.792 286.445 / 1)", "--surface-gradient": fadeFromSidebar },
      ),
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "Graphite · muted blue",
    colors: {
      light: palette(
        {
          sidebar: "#fafafa",
          body: "#fafafa",
          raised: "color-mix(in srgb, #141414 3.866%, #fafafa)",
          hover: "color-mix(in srgb, #141414 8.342%, #fafafa)",
          border: "#14141413",
          borderStrong: "#14141426",
          text: "#141414eb",
          secondaryText: "#141414ca",
          mutedText: "#141414a1",
          faintText: "#1414147d",
          bubble: "color-mix(in srgb, #141414 5.405%, #fafafa)",
        },
        "#2f6b97",
        "#2f6b97",
        "#fcfcfc",
        { "--mascot-body": "#2f6b97", "--mascot-eyes": "#ffffff" },
      ),
      dark: palette(
        {
          sidebar: "#161616",
          body: "#121212",
          raised: "color-mix(in srgb, #e4e4e4 5.427%, #121212)",
          hover: "color-mix(in srgb, #e4e4e4 8.834%, #121212)",
          border: "#e4e4e413",
          borderStrong: "#e4e4e426",
          text: "#e4e4e4",
          secondaryText: "#e4e4e4c4",
          mutedText: "#e4e4e48d",
          faintText: "#e4e4e467",
          bubble: "color-mix(in srgb, #e4e4e4 4.473%, #121212)",
        },
        "#81a1c1",
        "#81a1c1",
        "#191c22",
        { "--mascot-body": "#81a1c1", "--mascot-eyes": "#121212", "--surface-gradient": fadeFromSidebar },
      ),
    },
  },
  {
    id: "claude",
    name: "Claude",
    description: "Soft neutrals · ink controls",
    colors: {
      light: palette(
        {
          sidebar: "#faf9f5",
          body: "#faf9f5",
          raised: "#f2f0e8",
          hover: "#eae7dd",
          border: "#0b0b0b1a",
          borderStrong: "#0b0b0b33",
          text: "#0b0b0b",
          secondaryText: "#44433f",
          mutedText: "#686662",
          faintText: "#8a857e",
          bubble: "#f0eee6",
        },
        "#0b0b0b",
        "#184f95",
        "#ffffff",
        { "--mascot-body": "#d97757", "--mascot-eyes": "#ffffff", "--accent-soft": "color-mix(in srgb, #2a78d6 10%, #faf9f5)", "--selection": "color-mix(in srgb, #2a78d6 25%, #faf9f5)" },
      ),
      dark: palette(
        {
          sidebar: "#1f1e1d",
          body: "#1b1a19",
          raised: "#262523",
          hover: "#2d2c2a",
          border: "#ffffff1a",
          borderStrong: "#ffffff33",
          text: "#e4e3e1",
          secondaryText: "#b3b3a8",
          mutedText: "#9a988f",
          faintText: "#7c7a72",
          bubble: "#252422",
        },
        "#ffffff",
        "#6da7ec",
        "#0b0b0b",
        {
          "--mascot-body": "#d97757",
          "--mascot-eyes": "#1b1a19",
          "--accent-soft": "color-mix(in srgb, #2a78d6 14%, #1b1a19)",
          "--selection": "color-mix(in srgb, #2a78d6 30%, #1b1a19)",
          "--surface-gradient": fadeFromSidebar,
        },
      ),
    },
  },
  {
    id: "github",
    name: "GitHub",
    description: "Slate surfaces · GitHub blue",
    colors: {
      light: palette(
        {
          sidebar: "#ffffff",
          body: "#ffffff",
          raised: "#f6f8fa",
          hover: "#eff2f5",
          border: "#d1d9e0",
          borderStrong: "#818b98",
          text: "#1f2328",
          secondaryText: "#3d444d",
          mutedText: "#5e6974",
          faintText: "#7e8794",
          bubble: "#f6f8fa",
        },
        "#0969da",
        "#0969da",
        "#ffffff",
        { "--mascot-body": "#1f883d", "--mascot-eyes": "#ffffff", "--accent-soft": "#ddf4ff" },
      ),
      dark: palette(
        {
          sidebar: "#151c25",
          body: "#121721",
          raised: "#1b222c",
          hover: "#222a34",
          border: "#262d37",
          borderStrong: "#3d444f",
          text: "#d7dde3",
          secondaryText: "#a5acb7",
          mutedText: "#8b949e",
          faintText: "#6e7681",
          bubble: "#1a212b",
        },
        "#1f6feb",
        "#4493f8",
        "#ffffff",
        { "--mascot-body": "#3fb950", "--mascot-eyes": "#121721", "--accent-soft": "#388bfd1a", "--surface-gradient": fadeFromSidebar },
      ),
    },
  },
  // Halcyon (halcyon-theme.netlify.app) ships dark only. Dark follows the theme's own layout:
  // #171c28 frames the window and sidebar, #1d2433 is the work area, and #2f3b54 is its
  // highlight, so unlike the other palettes the body sits above the sidebar. Light carries the
  // same blue-grey into a near-white ground, with the gold kept as a fill and deepened for text.
  {
    id: "halcyon",
    name: "Halcyon",
    description: "Deep blue-grey · warm gold",
    colors: {
      light: palette(
        {
          sidebar: "#f8f9fc",
          body: "#f8f9fc",
          raised: "#eff2f7",
          hover: "#e7ebf2",
          border: "#e2e7ef",
          borderStrong: "#c9d1df",
          text: "#171c28",
          secondaryText: "#2f3b54",
          mutedText: "#4f5d7d",
          faintText: "#6679a4",
          bubble: "#eef1f7",
        },
        "#ffcc66",
        "#8a5a00",
        "#171c28",
        { "--mascot-body": "#e6a817", "--mascot-eyes": "#171c28" },
      ),
      dark: palette(
        {
          sidebar: "#171c28",
          body: "#1d2433",
          raised: "#252e41",
          hover: "#2f3b54",
          border: "#283043",
          borderStrong: "#3f495e",
          text: "#d7dce2",
          secondaryText: "#a2aabc",
          mutedText: "#8695b7",
          faintText: "#7385ab",
          bubble: "#262f42",
        },
        "#ffcc66",
        "#ffd580",
        "#171c28",
        { "--mascot-body": "#ffcc66", "--mascot-eyes": "#171c28", "--surface-gradient": fadeIntoSidebar },
      ),
    },
  },
  // Vintage Vogue swatch sampled from the user's reference: #575e51.
  // Dark grounds shade that smoky gray-green; stone text and bark retain the earthy warmth.
  {
    id: "kamakura",
    name: "Kamakura",
    description: "Dark earth green · smoky moss",
    colors: {
      light: palette(
        {
          sidebar: "#f5f3eb",
          body: "#f5f3eb",
          raised: "#eae8dd",
          hover: "#e0e2d4",
          border: "#dcded1",
          borderStrong: "#b9bda9",
          text: "#252c22",
          secondaryText: "#48513f",
          mutedText: "#5e6652",
          faintText: "#7b806e",
          bubble: "#e7e7d9",
        },
        "#575e51",
        "#454b40",
        "#ffffff",
        { "--mascot-body": "#a36a4b", "--mascot-eyes": "#ffffff" },
      ),
      dark: palette(
        {
          sidebar: "#1a1d18",
          body: "#21241e",
          raised: "#2e322b",
          hover: "#3a3f35",
          border: "#353a30",
          borderStrong: "#575e51",
          text: "#e0e1d5",
          secondaryText: "#c6cbbb",
          mutedText: "#b2baa6",
          faintText: "#959f88",
          bubble: "#2a2f26",
        },
        "#575e51",
        "#b5bfaa",
        "#ffffff",
        { "--mascot-body": "#a08769", "--mascot-eyes": "#1a1d18", "--surface-gradient": fadeIntoSidebar },
      ),
    },
  },
  {
    id: "clickup",
    name: "ClickUp",
    description: "Cool neutrals · vivid violet",
    colors: {
      light: palette(
        {
          sidebar: "#fafafa",
          body: "#fafafa",
          raised: "#f0f0f4",
          hover: "#e7e7ef",
          border: "#e3e3eb",
          borderStrong: "#c6c6d4",
          text: "#292d34",
          secondaryText: "#4f5360",
          mutedText: "#626674",
          faintText: "#7d808c",
          bubble: "#eeeaf7",
        },
        "#7b42df",
        "#7137ce",
        "#ffffff",
        { "--mascot-body": "#c63886", "--mascot-eyes": "#ffffff" },
      ),
      dark: palette(
        {
          sidebar: "#202127",
          body: "#1c1d22",
          raised: "#292a32",
          hover: "#33343e",
          border: "#363741",
          borderStrong: "#4d4e5b",
          text: "#f0eff5",
          secondaryText: "#c1bfce",
          mutedText: "#a5a2b6",
          faintText: "#868397",
          bubble: "#2e293c",
        },
        "#8550e5",
        "#c7a4ff",
        "#ffffff",
        { "--mascot-body": "#f18cbc", "--mascot-eyes": "#1c1d22", "--surface-gradient": fadeFromSidebar },
      ),
    },
  },
  // Neon belongs to actions and the mascot; reading surfaces keep a quiet indigo ground.
  {
    id: "cyberpunk",
    name: "Cyberpunk",
    description: "Midnight indigo · electric cyan",
    colors: {
      light: palette(
        {
          sidebar: "#f3f4fa",
          body: "#f3f4fa",
          raised: "#e8eaf4",
          hover: "#dde1ee",
          border: "#d9ddeb",
          borderStrong: "#b6bdd3",
          text: "#20243d",
          secondaryText: "#424c69",
          mutedText: "#58617f",
          faintText: "#75809a",
          bubble: "#e2eaf1",
        },
        "#007b8a",
        "#006978",
        "#ffffff",
        { "--mascot-body": "#bf278e", "--mascot-eyes": "#ffffff" },
      ),
      dark: palette(
        {
          sidebar: "#10111f",
          body: "#15172a",
          raised: "#20233b",
          hover: "#2c304b",
          border: "#2e324b",
          borderStrong: "#454b69",
          text: "#edf3ff",
          secondaryText: "#c0cbe4",
          mutedText: "#9faecb",
          faintText: "#7d8eae",
          bubble: "#222b42",
        },
        "#49e6ee",
        "#68eef4",
        "#10111f",
        { "--mascot-body": "#ff70cd", "--mascot-eyes": "#10111f", "--surface-gradient": fadeIntoSidebar },
      ),
    },
  },
  {
    id: "notion",
    name: "Notion",
    description: "Paper and charcoal · quiet blue",
    colors: {
      light: palette(
        {
          sidebar: "#fbfbfa",
          body: "#ffffff",
          raised: "#f1f1ef",
          hover: "#e8e8e5",
          border: "#e5e5e2",
          borderStrong: "#ccccc7",
          text: "#37352f",
          secondaryText: "#55534e",
          mutedText: "#686660",
          faintText: "#83817b",
          bubble: "#f1f1ef",
        },
        "#2376ad",
        "#216c9e",
        "#ffffff",
        { "--mascot-body": "#37352f", "--mascot-eyes": "#ffffff" },
      ),
      dark: palette(
        {
          sidebar: "#202020",
          body: "#191919",
          raised: "#272727",
          hover: "#303030",
          border: "#323232",
          borderStrong: "#484848",
          text: "#ebebea",
          secondaryText: "#c2c1be",
          mutedText: "#a4a39f",
          faintText: "#83827f",
          bubble: "#272727",
        },
        "#2376ad",
        "#79b8e1",
        "#ffffff",
        { "--mascot-body": "#ebebea", "--mascot-eyes": "#191919", "--surface-gradient": fadeFromSidebar },
      ),
    },
  },
  // Eliron's studio colors, from its site: a white canvas, graphite ink that also fills the
  // controls, and baby blue and pink laid flat. Light keeps the site's values, with its focus
  // blue for links and its pink for selection. The site has no dark mode, so dark grounds the
  // plane in the graphite and carries the pastels into the links, the bubble and the selection.
  // The mascot wears the pink Eliron dot in both modes. Mint marks success and lime attention:
  // in light they are fills, with darker inks of the same hues for text, and in dark the pastels
  // are the text.
  {
    id: "eliron",
    name: "Eliron",
    description: "White and graphite · baby blue and pink",
    colors: {
      light: palette(
        {
          sidebar: "#ffffff",
          body: "#ffffff",
          raised: "#f5f7f8",
          hover: "#eceff1",
          border: "#e0e3e5",
          borderStrong: "#c6cbcf",
          text: "#191c20",
          secondaryText: "#40464c",
          mutedText: "#60666b",
          faintText: "#82888d",
          bubble: "#cbefff",
        },
        "#191c20",
        "#415ba0",
        "#ffffff",
        {
          "--mascot-body": "#ffc9ff",
          "--mascot-eyes": "#191c20",
          "--accent-soft": "color-mix(in srgb, #cbefff 55%, #ffffff)",
          "--selection": "#ffc9ff",
          "--ok": "#187029",
          "--ok-soft": "#9ef2a4",
          "--warn": "#5e6304",
          "--warn-soft": "#e8f552",
        },
      ),
      dark: palette(
        {
          sidebar: "#121417",
          body: "#191c20",
          raised: "#22262b",
          hover: "#2b3036",
          border: "#272b31",
          borderStrong: "#363b42",
          text: "#e0e3e5",
          secondaryText: "#b9bfc4",
          mutedText: "#979da2",
          faintText: "#787e83",
          bubble: "#1f2d36",
        },
        "#f5f7f8",
        "#cbefff",
        "#191c20",
        {
          "--mascot-body": "#ffc9ff",
          "--mascot-eyes": "#191c20",
          "--selection": "color-mix(in srgb, #ffc9ff 26%, #191c20)",
          "--surface-gradient": fadeIntoSidebar,
          "--ok": "#9ef2a4",
          "--warn": "#e8f552",
        },
      ),
    },
  },
];
export const themePresets: ThemeTemplate[] = presets.map((preset) => ({
  ...preset,
  colors: { light: { ...statusTokens.light, ...preset.colors.light }, dark: { ...statusTokens.dark, ...preset.colors.dark } },
}));
