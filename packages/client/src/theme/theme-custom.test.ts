import { describe, expect, it } from "vitest";
import { themePresets } from "./theme-palettes.js";
import { editableTokens, normalizeHex, overridesFor, parseCustomColors, withColor, withoutColor, withoutOverrides, type CustomColors } from "./theme-custom.js";

describe("normalizeHex", () => {
  it("rejects anything that is not a six digit colour", () => {
    for (const value of ["", "#", "red", "#12345", "#1234567", "#gggggg", "#aabbccdd"]) expect(normalizeHex(value)).toBeNull();
  });
});

describe("translucent roles", () => {
  it("lets fills and lines take an alpha, and keeps every other role opaque", () => {
    expect(normalizeHex("#1717170D", true)).toBe("#1717170d");
    expect(normalizeHex("#fff8", true)).toBe("#ffffff88");
    expect(normalizeHex("#171717ff", true)).toBe("#171717");
    expect(normalizeHex("#171717", true)).toBe("#171717");
    let custom = withColor({}, "openorc", "light", "--surface-2", "#1717170d");
    custom = withColor(custom, "openorc", "light", "--line", "#ff000080");
    custom = withColor(custom, "openorc", "light", "--ink", "#11223344");
    custom = withColor(custom, "openorc", "light", "--surface-3", "#eaeaea");
    expect(overridesFor(custom, "openorc", "light")).toEqual({ "--surface-2": "#1717170d", "--line": "#ff000080", "--surface-3": "#eaeaea" });
    expect(parseCustomColors(JSON.stringify(custom))).toEqual(custom);
  });
  it("keeps applying a Background saved before the redesign to the same token, now the planes", () => {
    const saved = JSON.stringify({ openorc: { light: { "--surface": "#fafafa", "--surface-2": "#f7f7f7" } } });
    expect(overridesFor(parseCustomColors(saved), "openorc", "light")).toEqual({ "--surface": "#fafafa", "--surface-2": "#f7f7f7" });
  });
});

describe("overrides", () => {
  it("keeps palettes and appearance modes apart", () => {
    let custom: CustomColors = {};
    custom = withColor(custom, "codex", "dark", "--accent", "#ff0000");
    custom = withColor(custom, "codex", "light", "--accent", "#00ff00");
    custom = withColor(custom, "linear", "dark", "--accent", "#0000ff");
    expect(overridesFor(custom, "codex", "dark")).toEqual({ "--accent": "#ff0000" });
    expect(overridesFor(custom, "codex", "light")).toEqual({ "--accent": "#00ff00" });
    expect(overridesFor(custom, "linear", "dark")).toEqual({ "--accent": "#0000ff" });
    expect(overridesFor(custom, "github", "dark")).toEqual({});
  });
  it("ignores tokens outside the editable set and unusable values", () => {
    const custom = withColor(withColor({}, "codex", "dark", "--not-a-token", "#ff0000"), "codex", "dark", "--accent", "nope");
    expect(custom).toEqual({});
  });
  it("prunes empty entries so a reset leaves nothing behind", () => {
    const one = withColor({}, "codex", "dark", "--bg", "#101010");
    expect(withoutColor(one, "codex", "dark", "--bg")).toEqual({});
    expect(withoutOverrides(one, "codex", "dark")).toEqual({});
    expect(withoutOverrides(one, "codex", "light")).toBe(one);
    expect(withoutColor(one, "codex", "dark", "--ink")).toBe(one);
  });
  it("leaves the other mode of the same palette alone on reset", () => {
    let custom = withColor({}, "codex", "dark", "--bg", "#101010");
    custom = withColor(custom, "codex", "light", "--bg", "#fafafa");
    expect(withoutOverrides(custom, "codex", "dark")).toEqual({ codex: { light: { "--bg": "#fafafa" } } });
  });
});

describe("parseCustomColors", () => {
  it("round trips what the store writes", () => {
    const custom = withColor(withColor({}, "claude", "light", "--ink", "#123456"), "claude", "light", "--accent", "#ABCDEF");
    expect(parseCustomColors(JSON.stringify(custom))).toEqual({ claude: { light: { "--ink": "#123456", "--accent": "#abcdef" } } });
  });
  it("survives missing, malformed and stale storage", () => {
    expect(parseCustomColors(null)).toEqual({});
    expect(parseCustomColors("not json")).toEqual({});
    expect(parseCustomColors("[1,2]")).toEqual({});
    expect(parseCustomColors(JSON.stringify({ codex: { dark: { "--bg": 7 } } }))).toEqual({});
    expect(parseCustomColors(JSON.stringify({ retired: { dark: { "--bg": "#101010" } }, codex: { sepia: { "--bg": "#101010" } } }))).toEqual({});
  });
});

describe("editableTokens", () => {
  it("names each token once", () => {
    expect(new Set(editableTokens).size).toBe(editableTokens.length);
  });
  it("names only tokens every palette defines, so each row has a colour to show", () => {
    for (const theme of themePresets) {
      for (const mode of ["light", "dark"] as const) {
        expect(editableTokens.filter((token) => !(token in theme.colors[mode]))).toEqual([]);
      }
    }
  });
});
