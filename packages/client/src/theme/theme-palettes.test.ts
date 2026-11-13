import { describe, expect, it } from "vitest";
import { themePresets } from "./theme-palettes.js";

const colors = (id: string) => themePresets.find((theme) => theme.id === id)!.colors;

describe("themePresets", () => {
  it("gives OpenOrc one near-white ground, pieces set into it with white keys, grey fills and two inks", () => {
    expect(colors("openorc").light).toMatchObject({
      "--bg": "#fafafa",
      "--sidebar": "var(--bg)",
      "--surface": "#ffffff",
      "--surface-2": "#eeeeee",
      "--well": "color-mix(in srgb, var(--ink) 4.5%, var(--bg))",
      "--well-ring": "0 0 #0000",
      "--key": "#ffffff",
      "--composer-input": "var(--well)",
      "--bubble": "#f0f0f0",
      "--navigation-soft": "#eaeaea",
      "--line": "#e8e8e8",
      "--ink": "#252525",
      "--prose-ink": "#555555",
      "--ink-4": "#696969",
      "--line-number": "#808080",
      "--ok-soft": "#e4f0ea",
      "--bad-soft": "#f7eae8",
      "--accent": "#252525",
      "--accent-fg": "#ffffff",
    });
    expect(colors("openorc").light["--raised-shadow"]).toContain("#dadada");
    expect(colors("openorc").dark).toMatchObject({
      "--bg": "#171717",
      "--sidebar": "#141619",
      "--surface": "#202020",
      "--surface-2": "#262626",
      "--ink": "#ececec",
      "--prose-ink": "#a3a3a3",
      "--accent": "#ececec",
      "--accent-fg": "#171717",
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

  it("paints every ground flat, and keeps the sidebar on the window's ground where a palette does not tint it", () => {
    for (const theme of themePresets) {
      for (const mode of ["light", "dark"] as const) {
        const painted = Object.entries(theme.colors[mode]).filter(([, value]) => String(value).includes("gradient("));
        expect(painted, `${theme.id} ${mode}`).toEqual([]);
        if (theme.id !== "openorc") expect(theme.colors[mode]["--sidebar"], `${theme.id} ${mode} sidebar`).toBe("var(--bg)");
      }
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
