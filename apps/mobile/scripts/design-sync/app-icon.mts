import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Icon Composer centers each layer on a 1024-point canvas at the layer's own size. */
const canvas = 1024;
/** The cube's path is drawn centered in OpenOrcMark.tsx's 32-unit box. */
const markBox = 32;

/**
 * The phone's home-screen icon as an Icon Composer document, from the desktop's Dock icon (resources/icon.svg): the
 * tile's color fills the background and the cube becomes one glass layer, taking the same share of the icon as of the tile.
 */
export async function renderAppIcon(desktop: string): Promise<{ document: string; cube: string }> {
  const source = await readFile(resolve(desktop, "resources/icon.svg"), "utf8");
  const tile = /<rect x="\d+" y="\d+" width="(\d+)" height="\d+" rx="\d+" fill="#([0-9a-f]{6})" \/>/.exec(source);
  const cube = /<path transform="translate\(\d+ \d+\) scale\((\d+)\)" fill="(#[0-9a-f]{6})" fill-rule="evenodd" d="([^"]+)" \/>/.exec(source);
  if (!tile || !cube) throw new Error("design-sync no longer finds the Dock icon's tile and cube the way it reads them");
  const size = ((markBox * Number(cube[1]) * canvas) / Number(tile[1])).toFixed(2);
  const channel = (at: number) => (parseInt(tile[2]!.slice(at, at + 2), 16) / 255).toFixed(5);
  const document = {
    fill: { solid: `srgb:${channel(0)},${channel(2)},${channel(4)},1.00000` },
    groups: [{ layers: [{ "image-name": "cube.svg", name: "cube" }], shadow: { kind: "neutral", opacity: 0.5 }, translucency: { enabled: true, value: 0.5 } }],
    "supported-platforms": { squares: "shared" },
  };
  return {
    document: JSON.stringify(document),
    cube: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${markBox} ${markBox}"><path fill="${cube[2]}" fill-rule="evenodd" d="${cube[3]}" /></svg>\n`,
  };
}
