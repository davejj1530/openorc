import { describe, expect, it } from "vitest";
import { themePresets } from "./theme-palettes.js";

const colors = (id: string) => themePresets.find((theme) => theme.id === id)!.colors;

describe("themePresets", () => {
  it("gives OpenOrc a soft black and a warm off-white ground, pieces a quiet step off it with keys inside, two inks, and light as the accent", () => {
    expect(colors("openorc").light).toMatchObject({
      "--bg": "#f5f5f2",
      "--sidebar": "var(--bg)",
      "--surface": "#ffffff",
      "--surface-2": "#ecece9",
      "--paper": "var(--surface)",
      "--well": "var(--surface)",
      "--well-ring": "0 0 #0000",
      "--key": "#f4f4f2",
      "--composer-input": "var(--well)",
      "--bubble": "#ffffff",
      "--navigation-soft": "#ffffff",
      "--line": "#e5e5e3",
      "--ink": "#171717",
      "--prose-ink": "#515150",
      "--ink-4": "#676766",
      "--line-number": "#868684",
      "--ok-soft": "#e4f0ea",
      "--bad-soft": "#f7eae8",
      "--accent": "#171717",
      "--accent-fg": "#ffffff",
      "--working-ink": "var(--accent)",
    });
    expect(colors("openorc").light["--raised-shadow"]).toContain("rgb(23 23 23 / 0.06)");
    expect(colors("openorc").dark).toMatchObject({
      "--bg": "#141414",
      "--sidebar": "var(--bg)",
      "--surface": "#1c1c1c",
      "--paper": "var(--surface)",
      "--well": "#1c1c1c",
      "--well-ring": "0 0 #0000",
      "--key": "#262626",
      "--composer-input": "var(--well)",
      "--surface-2": "#222222",
      "--navigation-soft": "#272727",
      "--ink": "#ededeb",
      "--prose-ink": "#dededc",
      "--accent": "#ffffff",
      "--accent-fg": "#141414",
      "--working-ink": "var(--accent)",
    });
    for (const mode of ["light", "dark"] as const) {
      for (const lit of ["--lit", "--lit-strong"]) expect(colors("openorc")[mode][lit], `${mode} ${lit}`).not.toBe("0 0 #0000");
      expect(colors("openorc")[mode]["--lit-mark"], mode).toContain("drop-shadow(");
    }
  });

  it("keeps light flat in palettes that do not light their accents", () => {
    for (const theme of themePresets.filter((preset) => preset.id !== "openorc")) {
      for (const mode of ["light", "dark"] as const) {
        expect(theme.colors[mode], `${theme.id} ${mode}`).toMatchObject({ "--lit": "0 0 #0000", "--lit-strong": "0 0 #0000", "--lit-mark": "none", "--working-ink": "var(--ink-3)" });
      }
    }
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
