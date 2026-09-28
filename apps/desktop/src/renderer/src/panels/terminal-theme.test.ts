import { beforeEach, describe, expect, it, vi } from "vitest";
import { terminalTheme } from "./terminal-theme";

/**
 * toHex hands the value to a canvas, which is the browser resolving CSS rather
 * than this mapping deciding anything. Giving the value back unchanged leaves
 * every slot readable as the token it came from, and leaves the mix built for
 * the bright half visible as the string xterm would be asked to resolve.
 */
const passthrough = (value: string | undefined): string | null => (value === undefined || value === "" ? null : value);
const toHex = vi.hoisted(() => vi.fn<(value: string | undefined) => string | null>());
vi.mock("../lib/color", () => ({ toHex }));

// A custom property comes back from a computed style with the space that
// followed the colon, so --ink carries one here: trimming it is the read's job.
const palette: Record<string, string> = {
  "--ink": " #101010",
  "--bg": "#f0f0f0",
  "--bad": "#cc3322",
  "--ok": "#118844",
  "--warn": "#997700",
  "--accent": "#0055cc",
  "--selection": "#ccddff",
  "--ink-2": "#333333",
  "--ink-3": "#666666",
  "--ink-4": "#999999",
};

const tokens = (values: Record<string, string>): Pick<CSSStyleDeclaration, "getPropertyValue"> => ({
  getPropertyValue: (name) => values[name] ?? "",
});

beforeEach(() => {
  toHex.mockImplementation(passthrough);
});

describe("terminal theme", () => {
  it("gives each xterm slot the token that already means the same thing, lifting the bright half a quarter of the way to body ink", () => {
    expect(terminalTheme(tokens(palette), true)).toMatchObject({
      foreground: "#101010",
      background: "#f0f0f0",
      cursor: "#0055cc",
      cursorAccent: "#f0f0f0",
      selectionBackground: "#ccddff",
      black: "#999999",
      red: "#cc3322",
      green: "#118844",
      yellow: "#997700",
      blue: "#0055cc",
      white: "#333333",
      brightBlack: "#666666",
      brightWhite: "#101010",
      brightRed: "color-mix(in srgb, #cc3322 75%, #101010)",
      brightBlue: "color-mix(in srgb, #0055cc 75%, #101010)",
      brightMagenta: "color-mix(in srgb, #b17fe8 75%, #101010)",
    });
  });
  it("keeps purple and teal fixed per mode, since no palette has one to lend", () => {
    const loud = tokens({ ...palette, "--accent": "#ff00ff", "--ok": "#00ffff" });
    expect(terminalTheme(loud, true).magenta).toBe("#b17fe8");
    expect(terminalTheme(loud, true).cyan).toBe("#3fb8cc");
    expect(terminalTheme(loud, false).magenta).toBe("#8250df");
    expect(terminalTheme(loud, false).cyan).toBe("#137a8b");
  });
  it("falls back to the mode's own colours when the palette answers nothing", () => {
    const dark = terminalTheme(tokens({}), true);
    const light = terminalTheme(tokens({}), false);
    expect(dark).toMatchObject({ foreground: "#e6e6e6", background: "#1a1a1a", black: "#686868", brightBlack: "#878787" });
    expect(light).toMatchObject({ foreground: "#0d0d0d", background: "#ffffff", black: "#878787", brightBlack: "#686868" });
  });
  it("keeps the base colour when the browser cannot resolve the mix", () => {
    toHex.mockImplementation((value) => (value !== undefined && value.startsWith("color-mix") ? null : passthrough(value)));
    const theme = terminalTheme(tokens(palette), true);
    expect(theme.brightRed).toBe("#cc3322");
    expect(theme.brightMagenta).toBe("#b17fe8");
  });
});
