import type { Mode } from "./theme-palettes.js";

// Pieces: what sits on the ground (the composer, cards, Settings tiles) is the --well, drawn with its --well-ring,
// and a control inside a piece is a --key, one step off it. Light lifts pieces: the palette's plane with a thin ring
// and a faint shadow, keys on the raised fill. Dark carves them: the ground more than halfway to black with no ring,
// keys 8.5% of white over the piece. Derived from the palette's own roles, so a palette, or saved custom colours,
// that move those move the pieces with them.
export const pieceTokens: Record<Mode, Record<string, string>> = {
  light: {
    "--well": "var(--surface)",
    "--well-ring": "0 0 0 1px var(--line), 0 1px 2px rgb(0 0 0 / 0.05)",
    "--key": "var(--surface-2)",
    "--composer-input": "var(--well)",
  },
  dark: {
    "--well": "color-mix(in srgb, #000000 56%, var(--bg))",
    "--well-ring": "0 0 #0000",
    "--key": "color-mix(in srgb, #ffffff 8.5%, var(--well))",
    "--composer-input": "var(--well)",
  },
};
