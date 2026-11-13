import { describe, expect, it } from "vitest";
import { themePresets } from "./theme-palettes.js";

const colors = (id: string) => themePresets.find((theme) => theme.id === id)!.colors;

describe("themePresets", () => {
  it("gives OpenOrc the approved near-white ground, cool sidebar, grey fills, raised planes and two inks", () => {
    expect(colors("openorc").light).toMatchObject({
      "--bg": "#fafafa",
      "--sidebar": "#f9fbfd",
      "--surface": "#ffffff",
      "--surface-2": "#f0f0f0",
      "--bubble": "#f0f0f0",
      "--navigation-soft": "#eef0f3",
      "--line": "#ebebeb",
      "--ink": "#252525",
      "--prose-ink": "#646464",
      "--ink-4": "#6d6d6e",
      "--line-number": "#8a8a8a",
      "--ok-soft": "#e0fae3",
      "--bad-soft": "#fcecea",
      "--accent": "#252525",
      "--accent-fg": "#ffffff",
    });
    expect(colors("openorc").light["--raised-shadow"]).toContain("#e4e4e4");
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
