import { describe, expect, it } from "vitest";
import { darkGrade, daylightInks, ditherDaylight, ditherPainting, leanOf, toneAt, type Pixels } from "./painting-dither";

/** A painting of the given size, each pixel coloured by its place. */
function painting(width: number, height: number, color: (x: number, y: number) => [number, number, number]): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set([...color(x, y), 255], (y * width + x) * 4);
  }
  return { data, width, height };
}

const hexAt = (cells: Uint8ClampedArray, i: number) => `#${[0, 1, 2].map((c) => cells[i * 4 + c]!.toString(16).padStart(2, "0")).join("")}`;
const brightness = (cells: Uint8ClampedArray, i: number) => cells[i * 4]! + cells[i * 4 + 1]! + cells[i * 4 + 2]!;

describe("ditherPainting", () => {
  it("draws one opaque cell for each pixel of the fitted painting", () => {
    const cells = ditherPainting(
      painting(13, 7, (x) => [x * 19, x * 19, x * 19]),
      darkGrade,
    );
    expect(cells).toHaveLength(13 * 7 * 4);
    for (let i = 0; i < 13 * 7; i++) expect(cells[i * 4 + 3]).toBe(255);
  });

  it("keeps a black painting in the grade's darkest tone", () => {
    const cells = ditherPainting(
      painting(16, 16, () => [0, 0, 0]),
      darkGrade,
    );
    for (let i = 0; i < 256; i++) expect(hexAt(cells, i)).toBe(darkGrade.base[0]);
  });

  it("keeps to the grade's 50 swatches, lighter where the painting is lighter", () => {
    const width = 64;
    const cells = ditherPainting(
      painting(width, 32, (x, y) => [x * 4, x * 4, ((x + y) * 3) % 256]),
      darkGrade,
    );
    const used = new Set(Array.from({ length: width * 32 }, (_, i) => hexAt(cells, i)));
    expect(used.size).toBeGreaterThan(8);
    expect(used.size).toBeLessThanOrEqual(50);
    const column = (x: number) => Array.from({ length: 32 }, (_, y) => brightness(cells, y * width + x)).reduce((sum, value) => sum + value, 0);
    expect(column(4)).toBeLessThan(column(32));
    expect(column(32)).toBeLessThan(column(60));
  });

  it("gives the same cells for the same painting", () => {
    const source = painting(24, 24, (x, y) => [(x * 11) % 256, (y * 7) % 256, (x * y) % 256]);
    expect(ditherPainting(source, darkGrade)).toEqual(ditherPainting(source, darkGrade));
  });
});

describe("toneAt", () => {
  it("lets through as many of the 64 thresholds as the value is past its stop", () => {
    const thresholds = Array.from({ length: 64 }, (_, i) => (i + 0.5) / 64);
    const between = (0.32 + 0.55) / 2;
    const tones = thresholds.map((threshold) => toneAt(between, threshold));
    expect(new Set(tones)).toEqual(new Set([2, 3]));
    expect(tones.filter((tone) => tone === 3)).toHaveLength(32);
  });

  it("reaches the lightest tone only at full lightness", () => {
    expect(toneAt(0, 0.5)).toBe(0);
    expect(toneAt(0.99, 0.99)).toBe(6);
    expect(toneAt(1, 0.99)).toBe(7);
  });
});

describe("leanOf", () => {
  it("leans blue cool, red and yellow warm, and a grey neither way", () => {
    expect(leanOf(60, 90, 160)).toBe(0);
    expect(leanOf(200, 150, 60)).toBe(6);
    expect(leanOf(120, 120, 120)).toBe(3);
  });
});

describe("ditherDaylight", () => {
  const blues = new Set<string>(daylightInks.slice(0, 4));
  const whites = new Set<string>(daylightInks.slice(4, 6));
  const greens = new Set<string>(daylightInks.slice(6, 12));
  /** A varnished day as old paint holds it: cream cloud, grey-blue sky, ochre grass, olive leaves and deep shade. */
  const bands: [number, number, number][] = [
    [236, 226, 196],
    [140, 165, 190],
    [119, 105, 56],
    [57, 59, 43],
    [22, 24, 18],
  ];
  const day = painting(32, 40, (_, y) => bands[Math.floor(y / 8)]!);
  const cells = ditherDaylight(day);
  const share = (band: number, inks: Set<string>) => {
    let count = 0;
    for (let i = band * 8 * 32; i < (band + 1) * 8 * 32; i++) if (inks.has(hexAt(cells, i))) count++;
    return count / (8 * 32);
  };

  it("takes the varnish off: the cloud goes white, the sky blue, the grass and leaves green", () => {
    expect(share(0, whites)).toBeGreaterThan(0.7);
    expect(share(1, blues)).toBeGreaterThan(0.7);
    expect(share(2, greens)).toBeGreaterThan(0.7);
    expect(share(3, greens)).toBeGreaterThan(0.7);
  });

  it("draws every cell opaque in one of the day's inks", () => {
    const inks = new Set<string>(daylightInks);
    for (let i = 0; i < 32 * 40; i++) {
      expect(inks.has(hexAt(cells, i))).toBe(true);
      expect(cells[i * 4 + 3]).toBe(255);
    }
  });

  it("screens a smooth band with the ordered grid, the same way every time", () => {
    const ramp = painting(64, 8, (x) => [100 + x, 150 + x, 200]);
    const first = ditherDaylight(ramp);
    expect(new Set(Array.from({ length: 64 * 8 }, (_, i) => hexAt(first, i))).size).toBeGreaterThan(1);
    expect(ditherDaylight(ramp)).toEqual(first);
  });
});
