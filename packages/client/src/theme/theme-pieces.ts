import type { Mode } from "./theme-palettes.js";

// Pieces: what is set into the ground (the composer, the person's message, cards, steps, code in a reply, Settings
// tiles) is the --well, one step off the ground with no ring or shadow, and a control inside a piece is a --key, one
// step back. Light sets pieces in: the ground with 4.5% of its ink, keys on the palette's plane. Dark carves them: the
// ground more than halfway to black, keys 8.5% of white over the piece. Derived from the ground and the ink, so a
// palette, or saved custom colours, that move those move the pieces with them.
export const pieceTokens: Record<Mode, Record<string, string>> = {
  light: {
    "--well": "color-mix(in srgb, var(--ink) 4.5%, var(--bg))",
    "--well-ring": "0 0 #0000",
    "--key": "var(--surface)",
    "--composer-input": "var(--well)",
  },
  dark: {
    "--well": "color-mix(in srgb, #000000 56%, var(--bg))",
    "--well-ring": "0 0 #0000",
    "--key": "color-mix(in srgb, #ffffff 8.5%, var(--well))",
    "--composer-input": "var(--well)",
  },
};
