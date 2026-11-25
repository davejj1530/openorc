import { describe, expect, it } from "vitest";
import { themePresets } from "@openorc/client/theme";
import { paintPalette, resolveColor, toHex } from "../../src/look/paint.ts";
import { lchToHex, paletteColors, resolvePalette, stylesheetColors, type Cascade } from "./colors.mts";

const hex = (value: string, declarations: Record<string, string> = {}) => toHex(resolveColor(value, declarations)).slice(1);

// A small app.css: a ground, a color per mode, references into the palette, a ground-dependent fill, and values that are
// not colors.
const cascade: Cascade = {
  root: {
    "--bg": "#ababab",
    "--tone-think": "#000001",
    "--accent-ink": "#000003",
    "--navigation-soft": "#000004",
    "--ring": "var(--accent-ink)",
    "--current-row-fill": "var(--navigation-soft)",
    "--hairline": "1px",
    "--seam": "var(--hairline)",
    "--shadow-overlay": "0 0 32px -12px rgb(0 0 0 / 0.24)",
    "--lit-mark": "none",
  },
  dark: { "--tone-think": "#000002" },
};

describe("resolveColor", () => {
  it("follows var() chains and fallbacks", () => {
    expect(hex("var(--a)", { "--a": "var(--b)", "--b": "#112233" })).toBe("112233");
    expect(hex("var(--missing, #445566)")).toBe("445566");
  });

  it("keeps the alpha of 8-digit hex", () => {
    expect(hex("#1717170d")).toBe("1717170d");
  });

  it("mixes opaque colors in srgb, with one or both weights given", () => {
    expect(hex("color-mix(in srgb, #171717 12%, #ffffff)")).toBe("e3e3e3");
    expect(hex("color-mix(in srgb, var(--warn) 8%, var(--surface))", { "--warn": "#8b5c0a", "--surface": "#ffffff" })).toBe("f6f2eb");
    expect(hex("color-mix(in srgb, #000000 25%, #ffffff 75%)")).toBe("bfbfbf");
  });

  it("mixes a translucent color by how much of it is there, as CSS Color 5 does", () => {
    expect(hex("color-mix(in srgb, #ff000080, #0000ff)")).toBe("5500aac0");
    expect(hex("color-mix(in srgb, #ff000000, #0000ff)")).toBe("0000ff80");
  });

  it("fails on syntax it does not resolve", () => {
    expect(() => resolveColor("lch(50% 10 20)", {})).toThrow("Unsupported color syntax");
    expect(() => resolveColor("oklch(50% 0.1 20)", {})).toThrow("Unsupported color syntax");
    expect(() => resolveColor("color-mix(in oklab, #000000 50%, #ffffff)", {})).toThrow("Unsupported color-mix");
    expect(() => resolveColor("var(--a)", { "--a": "var(--b)", "--b": "var(--a)" })).toThrow("Circular");
    expect(() => resolveColor("var(--nothing)", {})).toThrow("not defined");
  });
});

describe("lch()", () => {
  // Read back from Chromium's own canvas, as the desktop paints these: a gray, Linear's light ground, its dark accent
  // (the brand's own #5e6ad2), and a white past the sRGB gamut that Chromium clips.
  it.each([
    ["lch(50% 0 0)", "#777777"],
    ["lch(96.5% 0.9 282 / 1)", "#f5f5f7"],
    ["lch(47.918% 59.303 288.421)", "#5e6ad2"],
    ["lch(100% 5 286.91 / 1)", "#fffeff"],
    ["lch(12.141% 17.792 286.445 / 1)", "#1c1e37"],
  ])("paints %s as %s", (value, expected) => {
    expect(lchToHex(value)).toBe(expected);
  });

  it("writes lch() as hex wherever a palette uses it, mixes included, so the phone never meets it", () => {
    const linear = paletteColors("linear", "light", cascade);
    expect(linear["--selection"]).toBe("#cad3f3");
    expect(Object.values(linear).filter((value) => /lch/i.test(value))).toEqual([]);
  });
});

describe("resolvePalette", () => {
  const authored = themePresets.find((preset) => preset.id === "openorc")!.colors;

  it("paints the palette over app.css, as the desktop's inline style does", () => {
    expect(resolvePalette("openorc", "light", cascade).bg).toBe(authored.light["--bg"]);
    expect(resolvePalette("openorc", "dark", cascade).bg).toBe(authored.dark["--bg"]);
  });

  it("reads the dark rule only in dark", () => {
    expect(resolvePalette("openorc", "light", cascade)["tone-think"]).toBe("#000001");
    expect(resolvePalette("openorc", "dark", cascade)["tone-think"]).toBe("#000002");
  });

  it("resolves stylesheet references against the palette", () => {
    expect(resolvePalette("openorc", "dark", cascade).ring).toBe(authored.dark["--accent-ink"]);
  });

  it("paints every palette in both modes with the default's tokens, Linear's lch() included", () => {
    const tokens = Object.keys(resolvePalette("openorc", "light", cascade));
    for (const { id } of themePresets) for (const mode of ["light", "dark"] as const) expect(Object.keys(resolvePalette(id, mode, cascade))).toEqual(tokens);
  });

  it("carries an override to every color that names it, as the desktop's live custom properties do", () => {
    const sheet = stylesheetColors(cascade, "light");
    const plain = paintPalette(paletteColors("openorc", "light", cascade), sheet);
    const changed = paintPalette(paletteColors("openorc", "light", cascade), sheet, { "--surface": "#fafaf0", "--accent": "#2768a5" });
    expect(changed.surface).toBe("#fafaf0");
    expect(changed.paper).toBe("#fafaf0");
    expect(changed["accent-ink"]).not.toBe(plain["accent-ink"]);
    expect(changed.ring).toBe(changed["accent-ink"]);
  });

  it("leaves out ground-dependent fills and values that are not colors", () => {
    const light = resolvePalette("openorc", "light", cascade);
    expect(light).not.toHaveProperty("current-row-fill");
    expect(light).not.toHaveProperty("hairline");
    expect(light).not.toHaveProperty("seam");
    expect(light).not.toHaveProperty("shadow-overlay");
    expect(light).not.toHaveProperty("lit-mark");
    expect(light).not.toHaveProperty("surface-gradient");
    expect(light).not.toHaveProperty("well-ring");
  });
});
