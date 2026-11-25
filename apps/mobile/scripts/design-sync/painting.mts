import { resolve } from "node:path";
import { paintingCrop, paintingScenes, type Mode } from "@openorc/client/theme";
import sharp from "sharp";

/**
 * New thread's painting as the phone shows it. The desktop dithers its picture live on a canvas, which the phone does
 * not have, so the same dither runs here, over the same pictures, and the phone ships the result: one image a mode,
 * its dots exact at every screen density.
 */

/** A dot's side in points, the desktop's own. */
const DOT = 2;

/**
 * The card's shapes, each a picture of its own, in dots: the desktop fits its picture to its card, so a tall card
 * shows less of the scene across than a wide one. A phone's, an iPad's on its side, and an iPad's upright. The phone
 * shows the first that covers its card, in this order.
 */
const SHAPES = [
  { name: "phone", width: 220, height: 430 },
  { name: "wide", width: 500, height: 470 },
  { name: "tall", width: 380, height: 640 },
] as const;
type Shape = (typeof SHAPES)[number];

/** The pictures by name with their sizes in points, which the phone lays its card out by. */
export const PAINTING_SHAPES = SHAPES.map(({ name, width, height }) => ({ name, width: width * DOT, height: height * DOT }));

const sources: Record<Mode, string> = { dark: "rosalie.jpg", light: "grassland.jpg" };
const names: Record<Mode, string> = { dark: "storm", light: "hill" };
/** The screen densities an image comes in: the plain file its import names, then iPads' 2x and iPhones' 3x. */
const densities = [1, 2, 3] as const;

/** One mode's picture for one shape as dithered cells, a dot a pixel. */
async function cells(desktop: string, mode: Mode, shape: Shape): Promise<Buffer> {
  const picture = sharp(resolve(desktop, "src/renderer/src/assets/backdrop", sources[mode]));
  const { width, height } = await picture.metadata();
  const scene = paintingScenes[mode];
  const crop = paintingCrop({ width, height }, scene, shape);
  const fitted = await picture
    .extract({ left: Math.round(crop.x), top: Math.round(crop.y), width: Math.round(crop.width), height: Math.round(crop.height) })
    .resize(shape.width, shape.height, { fit: "fill", kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return Buffer.from(scene.draw({ data: new Uint8ClampedArray(fitted), width: shape.width, height: shape.height }));
}

/**
 * The paintings as the app's image assets, `storm-phone.webp` and its `@2x` and `@3x` and so on for each mode and
 * shape, every dot a whole block of screen pixels.
 */
export async function renderPaintings(desktop: string, to: string): Promise<{ path: string; contents: Uint8Array }[]> {
  const pictures = (Object.keys(sources) as Mode[]).flatMap((mode) => SHAPES.map((shape) => ({ mode, shape })));
  const outputs = await Promise.all(
    pictures.map(async ({ mode, shape }) => {
      const dithered = await cells(desktop, mode, shape);
      return Promise.all(
        densities.map(async (density) => {
          const side = DOT * density;
          const contents = await sharp(dithered, { raw: { width: shape.width, height: shape.height, channels: 4 } })
            .resize(shape.width * side, shape.height * side, { kernel: "nearest" })
            .removeAlpha()
            .webp({ lossless: true, effort: 6 })
            .toBuffer();
          return { path: resolve(to, `${names[mode]}-${shape.name}${density === 1 ? "" : `@${density}x`}.webp`), contents: new Uint8Array(contents) };
        }),
      );
    }),
  );
  return outputs.flat();
}
