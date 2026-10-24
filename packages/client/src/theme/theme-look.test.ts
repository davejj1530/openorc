import { describe, expect, it } from "vitest";
import { withColor, type CustomColors } from "./theme-custom.js";
import { lookOf, readLook, sameLook } from "./theme-look.js";

describe("the look a Mac hands its phones", () => {
  const custom: CustomColors = withColor(withColor({}, "linear", "dark", "--accent", "#5e6ad2"), "codex", "light", "--accent", "#ff0000");

  it("carries the palette on screen and only the colors changed on it", () => {
    expect(lookOf("linear", custom)).toEqual({ palette: "linear", colors: { dark: { "--accent": "#5e6ad2" } } });
    expect(lookOf("github", custom)).toEqual({ palette: "github", colors: {} });
  });

  it("reads back as the palette and each mode's overrides", () => {
    expect(readLook(lookOf("linear", custom))).toEqual({ preset: "linear", overrides: { light: {}, dark: { "--accent": "#5e6ad2" } } });
    expect(readLook(null)).toEqual({ preset: "openorc", overrides: { light: {}, dark: {} } });
  });

  it("falls back to the default for a palette this client does not know, and keeps only colors it can paint", () => {
    expect(readLook({ palette: "aurora", colors: { light: { "--accent": "#123456" } } })).toEqual({ preset: "openorc", overrides: { light: {}, dark: {} } });
    expect(readLook({ palette: "codex", colors: { light: { "--accent": "red", "--hairline": "#000000", "--ink": "#222222" } } }).overrides.light).toEqual({ "--ink": "#222222" });
  });

  it("compares by what it paints, not by key order", () => {
    const a = { palette: "codex", colors: { light: { "--accent": "#ff0000", "--ink": "#222222" } } };
    const b = { palette: "codex", colors: { light: { "--ink": "#222222", "--accent": "#ff0000" }, dark: {} } };
    expect(sameLook(a, b)).toBe(true);
    expect(sameLook(a, { ...b, palette: "linear" })).toBe(false);
    expect(sameLook(a, { palette: "codex", colors: { light: { "--accent": "#ff0001", "--ink": "#222222" } } })).toBe(false);
    expect(sameLook(null, a)).toBe(false);
  });
});
