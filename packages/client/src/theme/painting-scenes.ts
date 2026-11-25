import { darkGrade, ditherDaylight, ditherPainting, type Pixels } from "./painting-dither.js";
import type { Mode } from "./theme-palettes.js";

/** The desktop's name for the backdrop that shows these scenes, which it hands its phones in its look. */
export const PAINTING_BACKDROP = "painting";

/**
 * A picture New thread shows: how far down from its top the card may show (its sky and far ground, never the near
 * ground), where its centre of interest sits across and down within that, and how its cells are drawn.
 */
export interface PaintingScene {
  reach: number;
  focus: { x: number; y: number };
  draw: (painting: Pixels) => Uint8ClampedArray<ArrayBuffer>;
}

/** Dark shows a storm over mountains in greens; light shows a green hill under a clear sky in its own colours. */
export const paintingScenes: Record<Mode, PaintingScene> = {
  dark: { reach: 0.6, focus: { x: 0.3, y: 0.5 }, draw: (painting) => ditherPainting(painting, darkGrade) },
  light: { reach: 0.9, focus: { x: 0.5, y: 0.25 }, draw: ditherDaylight },
};

/**
 * The part of a picture that fills `cells` across and down: scaled to cover them within the scene's reach, around its
 * centre of interest. In the picture's own pixels.
 */
export function paintingCrop(picture: { width: number; height: number }, { reach, focus }: Pick<PaintingScene, "reach" | "focus">, cells: { width: number; height: number }) {
  const shown = picture.height * reach;
  const scale = Math.max(cells.width / picture.width, cells.height / shown);
  const width = cells.width / scale;
  const height = cells.height / scale;
  return { x: (picture.width - width) * focus.x, y: (shown - height) * focus.y, width, height };
}
