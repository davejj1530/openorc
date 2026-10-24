import { describe, expect, it } from "vitest";
import { themePresets } from "@openorc/client/theme";
import { resolveColor, resolvePalette, toHex, type Cascade } from "./colors.mts";

const hex = (value: string, declarations: Record<string, string> = {}) => toHex(resolveColor(value, declarations)).slice(1);

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

  it("fails on syntax it does not resolve", () => {
    expect(() => resolveColor("lch(50% 10 20)", {})).toThrow("Unsupported color syntax");
    expect(() => resolveColor("color-mix(in oklab, #000000 50%, #ffffff)", {})).toThrow("Unsupported color-mix");
    expect(() => resolveColor("color-mix(in srgb, #00000080 50%, #ffffff)", {})).toThrow("translucent");
    expect(() => resolveColor("var(--a)", { "--a": "var(--b)", "--b": "var(--a)" })).toThrow("Circular");
    expect(() => resolveColor("var(--nothing)", {})).toThrow("not defined");
  });
});

describe("resolvePalette", () => {
  const cascade: Cascade = {
    root: { "--bg": "#ababab", "--tone-think": "#000001", "--ring": "var(--accent-ink)", "--current-row-fill": "var(--navigation-soft)", "--hairline": "1px" },
    dark: { "--tone-think": "#000002" },
  };
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

  it("leaves out ground-dependent fills and values that are not colors", () => {
    const light = resolvePalette("openorc", "light", cascade);
    expect(light).not.toHaveProperty("current-row-fill");
    expect(light).not.toHaveProperty("hairline");
    expect(light).not.toHaveProperty("surface-gradient");
  });
});
