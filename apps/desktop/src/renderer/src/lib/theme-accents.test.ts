import { describe, expect, it } from "vitest";
import { contrastRatio } from "./accent-colors";
import { accentCombinations, combinationColors, resolveAccentColors } from "./theme-accents";
import { themePresets } from "./theme-palettes";
import { overridesFor, parseCustomColors, withAccents, withColor, withoutAccents } from "./theme-custom";

const palette = themePresets.find((theme) => theme.id === "openorc")!;

describe("accent colors", () => {
  it("keeps existing custom colors and lets unspecified roles follow the original accent", () => {
    const old = { "--accent": "#123456", "--accent-ink": "#345678", "--accent-soft": "#ddeeff", "--accent-fg": "#ffffff", "--selection": "#abcdef" };
    const result = resolveAccentColors(palette.colors.light, old);
    expect(result).toMatchObject(old);
    expect(result["--navigation-ink"]).toBe(old["--accent-ink"]);
    expect(result["--content-soft"]).toBe(old["--accent-soft"]);
  });

  it("persists independent roles without affecting another palette, appearance, or surface", () => {
    let custom = withColor({}, "openorc", "light", "--surface", "#fafafa");
    custom = withAccents(custom, "openorc", "light", combinationColors("ocean", "light"));
    custom = withAccents(custom, "openorc", "dark", { "--content-accent": "#aabbcc" });
    custom = withAccents(custom, "codex", "light", { "--navigation-accent": "#445566" });
    const restored = parseCustomColors(JSON.stringify(custom));
    expect(restored).toEqual(custom);
    const reset = withoutAccents(restored, "openorc", "light");
    expect(overridesFor(reset, "openorc", "light")).toEqual({ "--surface": "#fafafa" });
    expect(overridesFor(reset, "openorc", "dark")).toEqual({ "--content-accent": "#aabbcc" });
    expect(overridesFor(reset, "codex", "light")).toEqual({ "--navigation-accent": "#445566" });
  });

  it("rebuilds matching text and tints when replacing a legacy accent, while rejecting invalid edits", () => {
    const custom = withColor({}, "openorc", "light", "--accent-ink", "#ff0000");
    expect(withAccents(custom, "openorc", "light", { "--accent": "nope" })).toBe(custom);
    const next = withAccents(custom, "openorc", "light", { "--accent": "#00f" });
    const overrides = overridesFor(next, "openorc", "light");
    expect(overrides).toEqual({ "--accent": "#0000ff" });
    const colors = resolveAccentColors(palette.colors.light, overrides);
    expect(colors["--accent-ink"]).toBe("#0000ff");
    expect(colors["--content-ink"]).toBe("#0000ff");
  });

  for (const mode of ["light", "dark"] as const) {
    it(`keeps OpenOrc's default labels and accents readable in ${mode} mode`, () => {
      const colors = resolveAccentColors(palette.colors[mode], {});
      expect(contrastRatio(colors["--accent"]!, colors["--accent-fg"]!)).toBeGreaterThanOrEqual(4.5);
      for (const surface of ["--surface", "--bg", "--surface-2"]) {
        for (const ink of ["--ink", "--ink-2", "--ink-3", "--ink-4", "--accent-ink"]) {
          expect(contrastRatio(colors[ink]!, colors[surface]!)).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`keeps preset accent text readable in ${mode} mode`, () => {
      for (const combination of accentCombinations) {
        const colors = resolveAccentColors(palette.colors[mode], combinationColors(combination.id, mode));
        expect(contrastRatio(colors["--accent"]!, colors["--accent-fg"]!)).toBeGreaterThanOrEqual(4.5);
        for (const role of ["accent", "navigation", "content"]) {
          expect(contrastRatio(colors[`--${role}-ink`]!, colors[`--${role}-soft`]!)).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(colors[`--${role}-ink`]!, colors["--surface"]!)).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`adapts very pale and very dark custom colors in ${mode} mode`, () => {
      for (const accent of ["#ffffff", "#000000", "#ffff00", "#777777", "#00ff00"]) {
        const colors = resolveAccentColors(palette.colors[mode], { "--accent": accent, "--navigation-accent": accent, "--content-accent": accent });
        expect(contrastRatio(colors["--accent"]!, colors["--accent-fg"]!)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors["--content-ink"]!, colors["--content-soft"]!)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
