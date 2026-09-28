import { describe, expect, it } from "vitest";
import { themePresets } from "./theme-palettes";
import { editableTokens, normalizeHex, overridesFor, parseCustomColors, withColor, withoutColor, withoutOverrides, type CustomColors } from "./theme-custom";

describe("normalizeHex", () => {
  it("rejects anything that is not a six digit colour", () => {
    for (const value of ["", "#", "red", "#12345", "#1234567", "#gggggg", "#aabbccdd"]) expect(normalizeHex(value)).toBeNull();
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
