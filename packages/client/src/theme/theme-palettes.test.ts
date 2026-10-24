import { describe, expect, it } from "vitest";
import { themePresets } from "./theme-palettes.js";

const colors = (id: string) => themePresets.find((theme) => theme.id === id)!.colors;

describe("themePresets", () => {
  it("gives OpenOrc the approved tile, plane, fills and ink", () => {
    expect(colors("openorc").light).toMatchObject({
      "--bg": "#f4f4f4",
      "--surface": "#ffffff",
      "--surface-2": "#1717170d",
      "--surface-3": "#17171717",
      "--line": "#17171717",
      "--ink": "#171717",
      "--accent": "#171717",
      "--accent-fg": "#ffffff",
    });
    expect(colors("openorc").dark).toMatchObject({
      "--bg": "#171717",
      "--surface": "#0a0a0a",
      "--surface-2": "#ffffff12",
      "--surface-3": "#ffffff1f",
      "--line": "#ffffff1c",
      "--ink": "#ffffff",
      "--accent": "#ffffff",
      "--accent-fg": "#000000",
    });
  });

  it("keeps Cursor's own values apart from OpenOrc", () => {
    expect(colors("cursor").light).toMatchObject({ "--bg": "#f3f3f3", "--surface": "#f7f7f7", "--paper": "#fdfdfd" });
    expect(colors("cursor").dark).toMatchObject({ "--bg": "#161616", "--surface": "#181818" });
  });

  it("steps every palette from the ground to its planes and fills", () => {
    for (const theme of themePresets) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = theme.colors[mode];
        expect(tokens["--surface"], `${theme.id} ${mode} plane`).not.toBe(tokens["--bg"]);
        expect(tokens["--surface-2"], `${theme.id} ${mode} fill`).not.toBe(tokens["--bg"]);
        expect(tokens["--composer-input"], `${theme.id} ${mode} writing area`).not.toBe(tokens["--bg"]);
      }
    }
  });

  it("keeps product workspaces flat when switching palettes", () => {
    const authored = new Set(["kamakura", "cyberpunk", "eliron"]);
    for (const theme of themePresets.filter((theme) => !authored.has(theme.id))) {
      for (const mode of ["light", "dark"] as const) expect(theme.colors[mode]["--surface-gradient"], `${theme.id} ${mode}`).toBe("none");
    }
  });

  it("gives every palette and mode the same colors, since switching palettes never clears one", () => {
    const tokens = Object.keys(themePresets[0]!.colors.light).sort();
    for (const key of ["--bad", "--bad-soft", "--attention"]) expect(tokens).toContain(key);
    for (const theme of themePresets) {
      for (const mode of ["light", "dark"] as const) expect(Object.keys(theme.colors[mode]).sort(), `${theme.id} ${mode}`).toEqual(tokens);
    }
  });
});
