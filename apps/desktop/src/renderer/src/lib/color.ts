// Palette values are authored as lch(), color-mix() and 8-digit hex, but
// <input type="color"> only takes #rrggbb. Painting one pixel lets the browser
// do the conversion for every syntax it supports.
let painter: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (painter === undefined) painter = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  return painter;
}

const channel = (value: number) => value.toString(16).padStart(2, "0");

/** Resolves any CSS color to `#rrggbb`, dropping alpha, or with `alpha` to `#rrggbbaa` when it is
 * translucent. Null when unsupported. */
export function toHex(value: string | undefined, alpha = false): string | null {
  // Hex is read directly: a canvas stores premultiplied pixels, which blurs a faint tint's color.
  const hex = value?.trim().toLowerCase();
  if (hex && /^#[0-9a-f]{8}$/.test(hex)) return alpha && !hex.endsWith("ff") ? hex : hex.slice(0, 7);
  const ctx = context();
  if (!ctx || value === undefined || !CSS.supports("color", value)) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const pixel = ctx.getImageData(0, 0, 1, 1).data;
  const opaque = !alpha || pixel[3] === 255;
  return `#${[...pixel.slice(0, opaque ? 3 : 4)].map(channel).join("")}`;
}
