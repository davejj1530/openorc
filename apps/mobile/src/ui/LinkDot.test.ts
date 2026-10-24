import type { ThemePreset } from "@openorc/client/theme";
import { expect, it } from "vitest";
import { palettes, stylesheet } from "../generated/palettes";
import { paintPalette } from "../look/paint";
import { linkInk } from "./LinkDot";

const channels = (hex: string) => [1, 3, 5, 7].map((at) => (hex.length > at ? parseInt(hex.slice(at, at + 2), 16) / 255 : 1)) as [number, number, number, number];

/** WCAG contrast of `color`, laid over the opaque `ground` when translucent, against that ground. */
function contrast(color: string, ground: string): number {
  const [r, g, b, a] = channels(color);
  const base = channels(ground);
  const seen = [r, g, b].map((channel, index) => channel * a + base[index]! * (1 - a));
  const luminance = ([red, green, blue]: number[]) => {
    const linear = [red!, green!, blue!].map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  };
  const [light, dark] = [luminance(seen), luminance(base)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

it("draws a Mac that is not trying at 3:1 or more on the ground, and no fainter than one connecting, in every palette", () => {
  for (const preset of Object.keys(palettes) as ThemePreset[]) {
    for (const mode of ["light", "dark"] as const) {
      const colors = paintPalette(palettes[preset][mode], stylesheet[mode]);
      const off = contrast(colors[linkInk.off]!, colors.bg!);
      expect(off, `${preset} ${mode}`).toBeGreaterThanOrEqual(3);
      expect(off, `${preset} ${mode}`).toBeGreaterThanOrEqual(contrast(colors[linkInk.busy]!, colors.bg!));
    }
  }
});
