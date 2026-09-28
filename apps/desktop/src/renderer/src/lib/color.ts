// Palette values are authored as lch(), color-mix() and 8-digit hex, but
// <input type="color"> only takes #rrggbb. Painting one pixel lets the browser
// do the conversion for every syntax it supports.
let painter: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (painter === undefined) painter = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  return painter;
}

const channel = (value: number) => value.toString(16).padStart(2, "0");

/** Resolves any CSS color to `#rrggbb`, dropping alpha. Null when unsupported. */
export function toHex(value: string | undefined): string | null {
  const ctx = context();
  if (!ctx || value === undefined || !CSS.supports("color", value)) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const pixel = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[...pixel.slice(0, 3)].map(channel).join("")}`;
}
