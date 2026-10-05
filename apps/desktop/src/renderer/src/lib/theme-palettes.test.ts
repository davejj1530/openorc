import { describe, expect, it } from "vitest";
import { themePresets } from "./theme-palettes";

describe("themePresets", () => {
  it("keeps OpenOrc identical to Cursor in both appearances", () => {
    expect(themePresets.find((theme) => theme.id === "openorc")!.colors).toEqual(themePresets.find((theme) => theme.id === "cursor")!.colors);
  });

  it("keeps product workspaces flat when switching palettes", () => {
    const authored = new Set(["kamakura", "cyberpunk", "eliron"]);
    for (const theme of themePresets.filter((theme) => !authored.has(theme.id))) {
      for (const mode of ["light", "dark"] as const) expect(theme.colors[mode]["--surface-gradient"], `${theme.id} ${mode}`).toBe("none");
    }
  });

  it("gives every palette and mode the same colors, since switching palettes never clears one", () => {
    const tokens = Object.keys(themePresets[0]!.colors.light).sort();
    for (const theme of themePresets) {
      for (const mode of ["light", "dark"] as const) expect(Object.keys(theme.colors[mode]).sort(), `${theme.id} ${mode}`).toEqual(tokens);
    }
  });
});
