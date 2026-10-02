/**
 * Flat drawings of an Orcling on a 100-unit square, for the designer's option
 * tiles and for places that show an Orcling without its Rive canvas. They
 * follow the Orcling Rive file's variants, in the same order.
 */

type Point = readonly [number, number];

const round = (value: number) => Math.round(value * 10) / 10;
const circle = (cx: number, cy: number, r: number) => `M${round(cx)} ${round(cy - r)}a${r} ${r} 0 1 1 0 ${2 * r}a${r} ${r} 0 1 1 0 ${-2 * r}Z`;

/** A closed polygon whose corners are rounded by `radius`. */
function roundedPolygon(points: readonly Point[], radius: number): string {
  const parts: string[] = [];
  points.forEach((point, index) => {
    const before = points[(index + points.length - 1) % points.length]!;
    const after = points[(index + 1) % points.length]!;
    const toward = (target: Point): Point => {
      const dx = target[0] - point[0];
      const dy = target[1] - point[1];
      const length = Math.hypot(dx, dy);
      return [point[0] + (dx / length) * radius, point[1] + (dy / length) * radius];
    };
    const start = toward(before);
    const end = toward(after);
    parts.push(`${index === 0 ? "M" : "L"}${round(start[0])} ${round(start[1])}Q${point[0]} ${point[1]} ${round(end[0])} ${round(end[1])}`);
  });
  return `${parts.join("")}Z`;
}

const ring = (count: number, cx: number, cy: number, distance: number, start = -90): Point[] =>
  Array.from({ length: count }, (_, index) => {
    const angle = ((start + (index * 360) / count) * Math.PI) / 180;
    return [cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance];
  });

const lobes = (count: number, distance: number, lobe: number, core: number) => [circle(50, 52, core), ...ring(count, 50, 52, distance).map(([x, y]) => circle(x, y, lobe))].join("");

/** Body silhouettes by the look's `shape` number. */
export const ORCLING_SHAPES: readonly { name: string; path: string }[] = [
  { name: "Soft square", path: "M50 13C80 13 87 20 87 50S80 87 50 87 13 80 13 50 20 13 50 13Z" },
  { name: "Circle", path: circle(50, 50, 37) },
  {
    name: "Triangle",
    path: roundedPolygon(
      [
        [50, 12],
        [90, 84],
        [10, 84],
      ],
      14,
    ),
  },
  { name: "Pill", path: "M33 28h34a22 22 0 0 1 0 44H33a22 22 0 0 1 0-44Z" },
  { name: "Bear", path: [circle(50, 56, 33), circle(23, 25, 12), circle(77, 25, 12)].join("") },
  { name: "Cloud", path: lobes(7, 24, 15, 27) },
  { name: "Heart", path: "M50 86C23 67 10 53 10 37 10 23 20 14 32 14c8 0 14 4 18 10 4-6 10-10 18-10 12 0 22 9 22 23 0 16-13 30-40 49Z" },
  { name: "Bow", path: "M50 41C41 22 12 22 12 50s29 28 38 9c9 19 38 19 38-9S59 22 50 41Z" },
  { name: "Apple", path: "M50 31c12-8 37-5 37 23 0 23-18 37-37 31-19 6-37-8-37-31 0-28 25-31 37-23ZM54 24c3-11 15-14 21-11-3 8-12 13-21 11Z" },
  { name: "Scallop", path: lobes(14, 31, 8, 33) },
  { name: "Hexagon", path: roundedPolygon(ring(6, 50, 50, 40, 0), 12) },
  { name: "Diamond", path: roundedPolygon(ring(4, 50, 50, 41), 14) },
];

/** Eye styles by the look's `eyes` number, drawn over the face at eye level 48. */
export const ORCLING_EYES: readonly { name: string }[] = [{ name: "Tall" }, { name: "Glossy" }, { name: "Dots" }, { name: "Sleepy" }, { name: "Big" }];
export const ORCLING_TEXTURES: readonly { name: string }[] = [{ name: "Flat" }, { name: "Soft" }, { name: "Glossy" }, { name: "Fuzzy" }];
export const ORCLING_GLASSES: readonly { name: string }[] = [{ name: "None" }, { name: "Round" }, { name: "Square" }, { name: "Shades" }];
export const ORCLING_ACCESSORIES: readonly { name: string }[] = [{ name: "None" }, { name: "Sprout" }, { name: "Bow" }, { name: "Party hat" }, { name: "Headphones" }, { name: "Crown" }];

/** Body colors the designer offers. Dark eyes read on every one. */
export const ORCLING_BODY_COLORS: readonly { name: string; hex: string }[] = [
  { name: "Pink", hex: "#ec7ba8" },
  { name: "Orchid", hex: "#c774d9" },
  { name: "Purple", hex: "#9b5cf2" },
  { name: "Blue", hex: "#4f7bf2" },
  { name: "Sky", hex: "#4eb0f5" },
  { name: "Teal", hex: "#52b8a0" },
  { name: "Lime", hex: "#bbd94c" },
  { name: "Yellow", hex: "#f5cf55" },
  { name: "Coral", hex: "#ef8a6c" },
  { name: "Cloud", hex: "#f4f4f7" },
];
export const ORCLING_EYE_COLORS: readonly { name: string; hex: string }[] = [
  { name: "Dark eyes", hex: "#1b1c20" },
  { name: "Light eyes", hex: "#f4f4f7" },
];

/** The eyes as SVG shapes in the eye color, with white glints where the style has them. */
export function orclingEyes(style: number): { path: string; glints: string } {
  switch (style) {
    case 1:
      return { path: "M37 40a6 8 0 1 1 0 16a6 8 0 1 1 0-16ZM63 40a6 8 0 1 1 0 16a6 8 0 1 1 0-16Z", glints: `${circle(38.5, 44.5, 2)}${circle(64.5, 44.5, 2)}` };
    case 2:
      return { path: `${circle(38, 48, 4)}${circle(62, 48, 4)}`, glints: "" };
    case 3:
      return { path: "M30 46a8 8 0 0 0 16 0ZM54 46a8 8 0 0 0 16 0Z", glints: "" };
    case 4:
      return { path: `${circle(37, 48, 9)}${circle(63, 48, 9)}`, glints: `${circle(40, 44, 3)}${circle(66, 44, 3)}` };
    default:
      return { path: "M36 38a4 4 0 0 1 4 4v12a4 4 0 0 1-8 0V42a4 4 0 0 1 4-4ZM64 38a4 4 0 0 1 4 4v12a4 4 0 0 1-8 0V42a4 4 0 0 1 4-4Z", glints: "" };
  }
}

/** Glasses by the look's `glasses` number, framed around the eyes: none, round, square, shades. */
export function orclingGlasses(style: number): { frames: string; lenses: string } | null {
  switch (style) {
    case 1:
      return { frames: `${circle(37, 48, 11)}${circle(63, 48, 11)}M48 46q2-2 4 0`, lenses: "" };
    case 2:
      return { frames: "M29 38h16a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H29a4 4 0 0 1-4-4V42a4 4 0 0 1 4-4ZM55 38h16a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H55a4 4 0 0 1-4-4V42a4 4 0 0 1 4-4ZM49 46h2", lenses: "" };
    case 3:
      return { frames: "M49 42h2", lenses: "M25 36h24v10a12 12 0 0 1-24 0ZM51 36h24v10a12 12 0 0 1-24 0Z" };
    default:
      return null;
  }
}

/** Accessories by the look's `accessory` number, on top of the head, each with its own colors. */
export function orclingAccessory(style: number): { path: string; fill: string; detail?: { path: string; fill: string } } | null {
  switch (style) {
    case 1:
      return { path: "M50 21c-1-6-7-11-15-10 1 7 8 11 15 10ZM50 21c1-6 7-11 15-10-1 7-8 11-15 10ZM49 13h2v9h-2Z", fill: "#62b85f" };
    case 2:
      return { path: "M66 16 54 8v16ZM66 16l12-8v16Z", fill: "#e8588a", detail: { path: circle(66, 16, 3.5), fill: "#c73f6f" } };
    case 3:
      return { path: "M50 1 62 22H38Z", fill: "#f5cf55", detail: { path: `${circle(50, 2, 4)}M44 16h12l-2-4h-8Z`, fill: "#ec7ba8" } };
    case 4:
      return {
        path: "M18 48a32 32 0 0 1 64 0h-5a27 27 0 0 0-54 0ZM13 42h9a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3V45a3 3 0 0 1 3-3ZM78 42h9a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3V45a3 3 0 0 1 3-3Z",
        fill: "#2c2f36",
      };
    case 5:
      return { path: "M34 23 30 7l10 7 10-11 10 11 10-7-4 16Z", fill: "#f4c542", detail: { path: circle(50, 13, 2.5), fill: "#e8588a" } };
    default:
      return null;
  }
}
