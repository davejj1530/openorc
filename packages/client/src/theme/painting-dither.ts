/**
 * The bundled paintings as the New thread screen draws them, one cell per dot, screened with an 8x8 ordered dither: the
 * night storm graded into eight tones of one green family, the day scene in a small set of its own natural colours.
 * Pure, so they run the same in a test as in the window.
 */

/** Pixels as a canvas holds them: four bytes a pixel, row by row. */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

type Ramp = readonly [string, string, string, string, string, string, string, string];

/**
 * Eight tones from the painting's darkest to its lightest, and the same tones leaning cool and warm. A cell's own
 * pigment picks how far toward either it leans, so the sky keeps its blue and the lit valley its yellow, all in green.
 */
export interface PaintingGrade {
  base: Ramp;
  cool: Ramp;
  warm: Ramp;
  /** The tone curve's exponent: above 1 deepens the middle, below 1 opens it. */
  lift: number;
}

/** A night picture: green-black shadow through emerald to a few near-white lights. */
export const darkGrade: PaintingGrade = {
  base: ["#020504", "#0b1510", "#1d412f", "#0e8648", "#49bb61", "#a4cf7e", "#dfe8bb", "#fafbee"],
  cool: ["#020504", "#0a1512", "#1a4136", "#09865a", "#39b873", "#93c995", "#d2e6c8", "#f3faef"],
  warm: ["#020504", "#0e160e", "#30422a", "#459632", "#79bf51", "#bed183", "#e6e9b8", "#fcfae9"],
  lift: 0.95,
};

/** Where each tone takes over along the painting's graded lightness. */
const STOPS = [0, 0.15, 0.32, 0.55, 0.78, 0.94, 0.985, 1];

/** The tone curve before the grade's lift: a black floor, a white point just under the lightest paint, a darker sky and a lighter valley. */
const FLOOR = 0.02;
const WHITE_PERCENTILE = 0.998;
const LIGHTING = [
  { ev: -0.3, at: 0.13, spread: 0.16 },
  { ev: 0.25, at: 0.74, spread: 0.12 },
];
const SHARPEN = { sigma: 1.1, amount: 0.45, threshold: 2 };
const LEANS = 7;

/** The 8x8 Bayer thresholds, each in (0, 1). */
const BAYER = (() => {
  let grid = [
    [0, 2],
    [3, 1],
  ];
  while (grid.length < 8) {
    const size = grid.length;
    grid = Array.from({ length: size * 2 }, (_, y) => Array.from({ length: size * 2 }, (_, x) => 4 * grid[y % size]![x % size]! + [0, 2, 3, 1][(y < size ? 0 : 2) + (x < size ? 0 : 1)]!));
  }
  return grid.map((row) => row.map((value) => (value + 0.5) / 64));
})();

const rgbOf = (hex: string): [number, number, number] => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];

/** The seven leans of each tone, coolest to warmest, as flat RGB: lean * 8 * 3 + tone * 3. */
function leanedTones(grade: PaintingGrade): Uint8Array {
  const base = grade.base.map(rgbOf);
  const cool = grade.cool.map(rgbOf);
  const warm = grade.warm.map(rgbOf);
  const tones = new Uint8Array(LEANS * STOPS.length * 3);
  for (let lean = 0; lean < LEANS; lean++) {
    const offset = (lean - 3) / 3;
    const other = offset < 0 ? cool : warm;
    for (let tone = 0; tone < STOPS.length; tone++) {
      for (let channel = 0; channel < 3; channel++) {
        tones[(lean * STOPS.length + tone) * 3 + channel] = Math.round(base[tone]![channel]! * (1 - Math.abs(offset)) + other[tone]![channel]! * Math.abs(offset));
      }
    }
  }
  return tones;
}

/** Each pixel's lightness, 0 to 255, weighted as sRGB is. */
function lightness({ data, width, height }: Pixels): Float32Array {
  const values = new Float32Array(width * height);
  for (let i = 0; i < values.length; i++) values[i] = (data[i * 4]! * 299 + data[i * 4 + 1]! * 587 + data[i * 4 + 2]! * 114) / 1000;
  return values;
}

/** A Gaussian blur along one axis, its edges held. */
function blurPass(values: Float32Array, width: number, height: number, kernel: number[], across: boolean): Float32Array {
  const out = new Float32Array(values.length);
  const reach = (kernel.length - 1) / 2;
  const limit = across ? width - 1 : height - 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -reach; k <= reach; k++) {
        const at = Math.min(limit, Math.max(0, (across ? x : y) + k));
        sum += kernel[k + reach]! * values[across ? y * width + at : at * width + x]!;
      }
      out[y * width + x] = sum;
    }
  }
  return out;
}

/** An unsharp mask: edges crisper by a fraction of their difference from a blur, small differences left alone. */
function sharpen(values: Float32Array, width: number, height: number): Float32Array {
  const reach = Math.ceil(SHARPEN.sigma * 3);
  const weights = Array.from({ length: reach * 2 + 1 }, (_, i) => Math.exp(-((i - reach) ** 2) / (2 * SHARPEN.sigma ** 2)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const kernel = weights.map((weight) => weight / total);
  const blurred = blurPass(blurPass(values, width, height, kernel, true), width, height, kernel, false);
  return values.map((value, i) => {
    const difference = value - blurred[i]!;
    return Math.abs(difference) < SHARPEN.threshold ? value : Math.min(255, Math.max(0, value + difference * SHARPEN.amount));
  });
}

/** The value a fraction of the way up the sorted values, between neighbours. */
function percentile(values: Float32Array, fraction: number): number {
  const sorted = values.slice().sort();
  const at = (sorted.length - 1) * fraction;
  const below = Math.floor(at);
  return sorted[below]! + (sorted[Math.min(sorted.length - 1, below + 1)]! - sorted[below]!) * (at - below);
}

/** Exposure in stops at a height down the picture: the lighting's soft bands, summed. */
const exposureAt = (down: number) => LIGHTING.reduce((sum, { ev, at, spread }) => sum + ev * Math.exp(-0.5 * ((down - at) / spread) ** 2), 0);

/** Lightness 0 to 1 after the floor, the white point, the lighting and the lift. A bounded curve never clips. */
function graded(values: Float32Array, width: number, height: number, lift: number): Float32Array {
  const white = percentile(values, WHITE_PERCENTILE) / 255;
  const span = Math.max(white - FLOOR, 0.01);
  const out = new Float32Array(values.length);
  for (let y = 0; y < height; y++) {
    const scale = 2 ** exposureAt(height > 1 ? y / (height - 1) : 0);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const value = Math.min(1, Math.max(0, (values[i]! / 255 - FLOOR) / span));
      out[i] = ((scale * value) / (1 + (scale - 1) * value)) ** lift;
    }
  }
  return out;
}

/** The tone a cell takes: the stop below its lightness, or the next one up where the threshold lets it through. */
export function toneAt(value: number, threshold: number): number {
  let tone = 0;
  while (tone < STOPS.length - 2 && value >= STOPS[tone + 1]!) tone++;
  const low = STOPS[tone]!;
  const high = STOPS[tone + 1]!;
  return (value - low) / (high - low) > threshold ? tone + 1 : tone;
}

/** How a pixel's pigment leans, 0 coolest to 6 warmest: red against blue, relative to its brightest channel. */
export function leanOf(red: number, green: number, blue: number): number {
  const warmth = Math.min(1, Math.max(-1, ((red - blue) / 255 / (Math.max(red, green, blue) / 255 + 0.04)) * 2.2));
  return Math.round((warmth + 1) * 3);
}

/**
 * The painting, already fitted to one pixel a cell, as its graded and dithered cells. Every cell is one of the grade's
 * swatches, chosen from its own lightness and pigment and its place in the 8x8 grid.
 */
export function ditherPainting(painting: Pixels, grade: PaintingGrade): Uint8ClampedArray<ArrayBuffer> {
  const { data, width, height } = painting;
  const values = graded(sharpen(lightness(painting), width, height), width, height, grade.lift);
  const tones = leanedTones(grade);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = BAYER[y % 8]!;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const tone = toneAt(values[i]!, row[x % 8]!);
      const swatch = (leanOf(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!) * STOPS.length + tone) * 3;
      out[i * 4] = tones[swatch]!;
      out[i * 4 + 1] = tones[swatch + 1]!;
      out[i * 4 + 2] = tones[swatch + 2]!;
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}

/** A colour in OKLab: lightness 0 to 1, and its green-red and blue-yellow axes. */
type Lab = [number, number, number];

const LINEAR = Array.from({ length: 256 }, (_, value) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** A linear-light RGB colour, 0 to 1 a channel, in OKLab. */
function oklab(r: number, g: number, b: number): Lab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** An sRGB colour, 0 to 255 a channel, in OKLab. */
const labOf = (red: number, green: number, blue: number): Lab => oklab(LINEAR[red]!, LINEAR[green]!, LINEAR[blue]!);

/**
 * The day scene's inks: sky blues, cloud whites, the greens of shade, leaf and sunlit grass, a sage for water and
 * haze, two earths and one deep shadow. A cell takes the nearest of them, so blue paint lands on a blue and green paint on a green.
 */
export const daylightInks = [
  "#2a5fae",
  "#4a86d6",
  "#82b2ea",
  "#bad6f3",
  "#e8eef3",
  "#ffffff",
  "#1c3a22",
  "#2d5d2b",
  "#4e8a34",
  "#86b94b",
  "#c2db86",
  "#5d7867",
  "#9a7a4e",
  "#cbb68c",
  "#262b2c",
] as const;

/** How the varnish is taken off: the lightest paint is balanced back to white, then colour and light are restored. */
const DAYLIGHT = {
  /** The share of the lightest cells whose average colour is taken as the varnish's tint. */
  highlights: 0.04,
  /** How much stronger colour is after the cast is gone. */
  chroma: 1.3,
  /** Yellowed leaves and grass, hues from `from` (full by `full`), are pulled this far toward `target`, and their colour raised by `boost`. */
  green: { from: 45, full: 72, target: 138, pull: 0.75, boost: 0.25 },
  /** Warm paint this light and this grey loses its colour, so clouds read white while a sunlit lawn keeps its green. */
  clouds: { from: 0.62, white: 0.84, grey: 0.05, coloured: 0.1 },
  /** How much stronger the sky's blue gets. */
  sky: 0.45,
  /** Lightness is stretched so these percentiles become the darkest and lightest shown. */
  low: 0.01,
  high: 0.995,
  floor: 0.24,
  /** The day is brighter than the paint: lightness is raised along this curve. */
  lift: 0.75,
  /** How far each step of the 8x8 grid moves a cell's lightness before its ink is chosen. */
  spread: 0.11,
  /** Hue counts this much more than lightness when choosing the nearest ink. */
  hueWeight: 2.2,
};

/**
 * The light each channel needs to make the painting's lightest paint neutral again: old varnish tints it yellow, so its
 * blue is raised and its red lowered, in proportion, everywhere.
 */
function varnishGains({ data, width, height }: Pixels): [number, number, number] {
  const luminance = new Float32Array(width * height);
  for (let i = 0; i < luminance.length; i++) luminance[i] = 0.2126 * LINEAR[data[i * 4]!]! + 0.7152 * LINEAR[data[i * 4 + 1]!]! + 0.0722 * LINEAR[data[i * 4 + 2]!]!;
  const bright = percentile(luminance, 1 - DAYLIGHT.highlights);
  const sum = [0, 0, 0];
  for (let i = 0; i < luminance.length; i++) {
    if (luminance[i]! < bright) continue;
    for (let channel = 0; channel < 3; channel++) sum[channel]! += LINEAR[data[i * 4 + channel]!]!;
  }
  const mean = (sum[0]! + sum[1]! + sum[2]!) / 3;
  return sum.map((value) => (value > 0 ? mean / value : 1)) as [number, number, number];
}

/** The painting's cells in OKLab, white balanced against its varnish, with its light and colour restored. */
function cleaned(painting: Pixels): Float32Array {
  const { data, width, height } = painting;
  const [red, green, blue] = varnishGains(painting);
  const lab = new Float32Array(width * height * 3);
  const lightness = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const color = oklab(Math.min(1, LINEAR[data[i * 4]!]! * red), Math.min(1, LINEAR[data[i * 4 + 1]!]! * green), Math.min(1, LINEAR[data[i * 4 + 2]!]! * blue));
    lab.set(color, i * 3);
    lightness[i] = color[0];
  }
  const low = percentile(lightness, DAYLIGHT.low);
  const span = Math.max(percentile(lightness, DAYLIGHT.high) - low, 0.01);
  for (let i = 0; i < lightness.length; i++) {
    const l = Math.min(1, Math.max(0, (lab[i * 3]! - low) / span));
    lab.set(restored(DAYLIGHT.floor + (1 - DAYLIGHT.floor) * l ** DAYLIGHT.lift, lab[i * 3 + 1]!, lab[i * 3 + 2]!), i * 3);
  }
  return lab;
}

const smoothstep = (from: number, to: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/**
 * A colour as it looked before the varnish yellowed: olive leaves and grass turn back toward green, warm light in
 * the clouds back to white, and the sky's blue clears. Hue is in degrees around OKLab's colour wheel.
 */
function restored(l: number, a: number, b: number): Lab {
  let hue = (Math.atan2(b, a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  let chroma = Math.hypot(a, b) * DAYLIGHT.chroma;
  const cream = smoothstep(25, 45, hue) * (1 - smoothstep(110, 130, hue)) * (1 - smoothstep(DAYLIGHT.clouds.grey, DAYLIGHT.clouds.coloured, chroma));
  chroma *= 1 - cream * smoothstep(DAYLIGHT.clouds.from, DAYLIGHT.clouds.white, l);
  const olive = smoothstep(DAYLIGHT.green.from, DAYLIGHT.green.full, hue) * (1 - smoothstep(DAYLIGHT.green.target - 5, DAYLIGHT.green.target, hue));
  hue += (DAYLIGHT.green.target - hue) * olive * DAYLIGHT.green.pull;
  chroma *= 1 + olive * DAYLIGHT.green.boost;
  const sky = smoothstep(200, 230, hue) * (1 - smoothstep(290, 310, hue));
  chroma *= 1 + sky * DAYLIGHT.sky;
  const radians = (hue * Math.PI) / 180;
  return [l, chroma * Math.cos(radians), chroma * Math.sin(radians)];
}

const INKS = daylightInks.map((hex) => ({ rgb: rgbOf(hex), lab: labOf(...rgbOf(hex)) }));

/** The ink nearest a colour, hue weighted over lightness. */
function nearestInk(l: number, a: number, b: number): number {
  let best = 0;
  let distance = Infinity;
  for (let ink = 0; ink < INKS.length; ink++) {
    const [il, ia, ib] = INKS[ink]!.lab;
    const d = (l - il) ** 2 + DAYLIGHT.hueWeight * ((a - ia) ** 2 + (b - ib) ** 2);
    if (d < distance) {
      distance = d;
      best = ink;
    }
  }
  return best;
}

/**
 * The painting, already fitted to one pixel a cell, as a day scene in its own colours: varnish taken off, then each cell
 * nudged by its place in the 8x8 grid and given the nearest of the day's inks.
 */
export function ditherDaylight(painting: Pixels): Uint8ClampedArray<ArrayBuffer> {
  const { width, height } = painting;
  const lab = cleaned(painting);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = BAYER[y % 8]!;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const [r, g, b] = INKS[nearestInk(lab[i * 3]! + (row[x % 8]! - 0.5) * DAYLIGHT.spread, lab[i * 3 + 1]!, lab[i * 3 + 2]!)]!.rgb;
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}
