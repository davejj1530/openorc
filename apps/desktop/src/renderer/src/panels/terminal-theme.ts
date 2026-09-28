import type { ITheme } from "@xterm/xterm";
import { toHex } from "../lib/color";

/** The palette, read the one way this needs it. A computed style is one; so is anything else that answers for a custom property. */
type Tokens = Pick<CSSStyleDeclaration, "getPropertyValue">;

/**
 * xterm paints its own surface and cannot read a custom property, so every
 * colour has to be handed over as a value. toHex resolves whatever syntax the
 * palette is authored in, the way the colour rows in Settings do. What the
 * document says is the caller's to read: this is the mapping alone, which is
 * the part with a decision in it.
 */
export function terminalTheme(tokens: Tokens, dark: boolean): ITheme {
  const token = (name: string, fallback: string): string => toHex(tokens.getPropertyValue(name).trim()) ?? fallback;
  const ink = token("--ink", dark ? "#e6e6e6" : "#0d0d0d");
  const background = token("--bg", dark ? "#1a1a1a" : "#ffffff");
  const red = token("--bad", dark ? "#d06557" : "#aa4538");
  const green = token("--ok", dark ? "#22975d" : "#157447");
  const yellow = token("--warn", dark ? "#a47f29" : "#8b5c0a");
  const blue = token("--accent", dark ? "#0875e1" : "#0169cc");
  // No palette has a purple or a teal to lend, so these two are fixed at the
  // weight --ok and --bad carry in each mode rather than borrowed from a token
  // that means something else.
  const magenta = dark ? "#b17fe8" : "#8250df";
  const cyan = dark ? "#3fb8cc" : "#137a8b";
  // The bright half is the same hue lifted a quarter of the way to body ink,
  // so `ls --color` keeps its two tones without inventing a colour the user
  // never picked.
  const bright = (color: string): string => toHex(`color-mix(in srgb, ${color} 75%, ${ink})`) ?? color;
  return {
    background,
    foreground: ink,
    cursor: blue,
    cursorAccent: background,
    selectionBackground: token("--selection", dark ? "#1f3a66" : "#d6e4ff"),
    black: token("--ink-4", dark ? "#686868" : "#878787"),
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: token("--ink-2", dark ? "#b5b5b5" : "#444444"),
    brightBlack: token("--ink-3", dark ? "#878787" : "#686868"),
    brightRed: bright(red),
    brightGreen: bright(green),
    brightYellow: bright(yellow),
    brightBlue: bright(blue),
    brightMagenta: bright(magenta),
    brightCyan: bright(cyan),
    brightWhite: ink,
  };
}
