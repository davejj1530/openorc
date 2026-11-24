/**
 * OpenOrc's state marks. A thread's mark is the OpenOrc cube as 19 dots under a light: where the light is and how it
 * moves says what the thread is doing. A project's mark is the same cube as an open frame, the place its threads'
 * solid cubes live in; its top face fills while they work. A mark's colour is never its own: it names a role of the
 * theme on screen, by what the mark says.
 *
 * A thread's mark is arithmetic: its dots and, for each, evenly spaced moments of one loop. The apps draw the dots and
 * play the moments with their own animation, so no frame is computed while a mark runs.
 */

/** One moment of a dot: how full it is, and how much of its colour it wears, from faded into the ground to whole. Both 0 to 1. */
export interface DotFrame {
  size: number;
  ramp: number;
}

/**
 * The theme's role a mark wears, by what it says: `work` for an agent at work, `think` for one thinking, `ink` for a
 * result, `attention` where the person is needed, `bad` for a failure, `ok` for a pull request, `quiet` for what waits
 * on nobody here. Each app draws a tone in its theme's own colour for that role.
 */
export type MarkTone = "work" | "think" | "ink" | "attention" | "bad" | "ok" | "quiet";

/** A dot in the mark's 24 unit box, centred on 0,0, with its loop. */
export interface MarkDot {
  x: number;
  y: number;
  frames: DotFrame[];
}

/** A mark ready to draw: its dots at `radius` when full, looping every `period` ms. A still mark has one frame and no period. */
export interface MarkMotion {
  tone: MarkTone;
  period: number;
  radius: number;
  dots: MarkDot[];
}

export type ThreadMarkKind =
  | "working"
  | "thinking"
  | "reading"
  | "searching"
  | "editing"
  | "running"
  | "delegating"
  | "replying"
  | "question"
  | "approval"
  | "mention"
  | "waiting"
  | "done"
  | "failed"
  | "background"
  | "open"
  | "merged"
  | "closed";

const TAU = Math.PI * 2;
const clamp = (value: number): number => Math.min(1, Math.max(0, value));
/** A soft peak: 1 at no distance, falling off over `width`. */
const bell = (distance: number, width: number): number => Math.exp(-((distance / width) ** 2));
/** The angle between two directions, the short way round. */
const between = (a: number, b: number): number => {
  const turn = Math.abs(a - b) % TAU;
  return turn > Math.PI ? TAU - turn : turn;
};

type Face = "top" | "right" | "left";

/** A point of the cube: where it is, and what the patterns ask of it. */
interface CubePoint {
  x: number;
  y: number;
  /** 0 the centre, 1 the six around it, 2 the edge. */
  ring: number;
  /** Its direction from the centre, anticlockwise from the right. */
  angle: number;
  /** 0 at the top of the cube, 1 at its foot. */
  down: number;
  /** 0 at its left, 1 at its right. */
  across: number;
  column: number;
  /** The faces it lies on: one inside a face, two on a seam, three at the centre. */
  faces: Face[];
  /** Its turn when the cube is built from the centre out. */
  order: number;
}

const STEP = 4.4;
const CUBE_RADIUS = 2.05;

/** The faces a point lies on, from its ring and its direction in degrees: the seams run at 30, 150 and 270. */
function facesAt(ring: number, degrees: number): Face[] {
  const on = (seam: number): boolean => Math.abs(degrees - seam) < 1;
  if (ring === 0) return ["top", "right", "left"];
  if (on(30)) return ["top", "right"];
  if (on(150)) return ["top", "left"];
  if (on(270)) return ["right", "left"];
  if (degrees > 30 && degrees < 150) return ["top"];
  return degrees > 150 && degrees < 270 ? ["left"] : ["right"];
}

function cubePoints(): CubePoint[] {
  const wide = (STEP * Math.sqrt(3)) / 2;
  const points: CubePoint[] = [];
  for (let q = -2; q <= 2; q++) {
    for (let r = -2; r <= 2; r++) {
      if (Math.abs(q + r) > 2) continue;
      const x = wide * r;
      const y = STEP * (q + r / 2);
      const ring = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
      const angle = (Math.atan2(-y, x) + TAU) % TAU;
      const faces = facesAt(ring, (angle * 180) / Math.PI);
      points.push({ x, y, ring, angle, down: (y + 2 * STEP) / (4 * STEP), across: (x + 2 * wide) / (4 * wide), column: r, faces, order: 0 });
    }
  }
  // Built from the centre, each ring clockwise from the top.
  const clockwise = (point: CubePoint): number => (TAU + Math.PI / 2 - point.angle) % TAU;
  [...points].sort((a, b) => a.ring - b.ring || clockwise(a) - clockwise(b)).forEach((point, index) => (point.order = index));
  return points;
}

const CUBE = cubePoints();
const FACING: Record<Face, number> = { top: Math.PI / 2, right: (Math.PI * 11) / 6, left: (Math.PI * 7) / 6 };
/** How lit a point is when each face is: a seam takes the mean of its faces. */
const lit = (point: CubePoint, faces: Record<Face, number>): number => point.faces.reduce((sum, face) => sum + faces[face], 0) / point.faces.length;

/** How full an unlit dot stays, so the cube is always there. */
const REST = 0.14;
const over = (light: number): number => REST + (1 - REST) * light;

/** A thread state: its colours, its loop, and how lit a point is `at` a fraction of the loop. */
interface Pattern {
  tone: MarkTone;
  period: number;
  light: (point: CubePoint, at: number) => number;
}

const still = (tone: MarkTone, light: (point: CubePoint) => number): Pattern => ({ tone, period: 0, light });
const orbit: Pattern["light"] = (point, at) => {
  const sun = Math.PI / 2 - TAU * at;
  return over(lit(point, { top: clamp((Math.cos(sun - FACING.top) + 0.5) / 1.5), right: clamp((Math.cos(sun - FACING.right) + 0.5) / 1.5), left: clamp((Math.cos(sun - FACING.left) + 0.5) / 1.5) }));
};

const PATTERNS: Record<ThreadMarkKind, Pattern> = {
  // The light goes round the three faces: at work, on nothing the mark can name.
  working: { tone: "work", period: 2400, light: orbit },
  // Rings spread from the centre.
  thinking: { tone: "think", period: 1900, light: (point, at) => over((0.5 + 0.5 * Math.cos(TAU * (at - point.ring / 3.2))) ** 2) },
  // A line reads down the cube.
  reading: { tone: "work", period: 1700, light: (point, at) => over(bell(point.down - (at * 1.5 - 0.25), 0.2)) },
  // A beam sweeps round, as a radar does.
  searching: { tone: "work", period: 1700, light: (point, at) => (point.ring ? over(bell(between(point.angle, TAU - TAU * at), 0.62)) : 0.7) },
  // The cube is built dot by dot, held, and cleared.
  editing: {
    tone: "work",
    period: 2800,
    light: (point, at) => over(clamp((at < 0.72 ? (at / 0.72) * 20 : 20) - point.order) * (at > 0.9 ? 1 - (at - 0.9) / 0.1 : 1)),
  },
  // Columns fall, each a little after its neighbour.
  running: { tone: "work", period: 1150, light: (point, at) => over(bell(point.down - ((((at + point.column * 0.37) % 1) + 1) % 1) * 1.5 + 0.25, 0.22)) },
  // The three faces take turns: several at work.
  delegating: { tone: "work", period: 2000, light: orbit },
  // A wave runs along the middle, as a line being written.
  replying: { tone: "work", period: 1200, light: (point, at) => (Math.abs(point.y) > STEP * 0.6 ? REST : 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(TAU * (at - point.across * 0.9))) ** 1.5) },
  // The light rests on the top face and breathes: it asked something.
  question: { tone: "attention", period: 2600, light: (point, at) => lit(point, { top: 0.86 + 0.14 * Math.sin(TAU * at), right: REST, left: REST }) },
  // A closed ring around a pulsing centre: it waits at a gate.
  approval: { tone: "attention", period: 1600, light: (point, at) => [0.55 + 0.45 * Math.sin(TAU * at), 0.05, 1][point.ring]! },
  // The heart of the cube alone: someone named you.
  mention: still("attention", (point) => (point.ring < 2 ? 1 : 0.05)),
  // The top lit and still, in grey: it waits on someone else.
  waiting: still("quiet", (point) => lit(point, { top: 0.9, right: REST, left: REST })),
  // The whole cube, with a sheen passing over it now and then.
  done: { tone: "ink", period: 4200, light: () => 1 },
  // The light is out.
  failed: still("bad", (point) => lit(point, { top: 0.05, right: 1, left: 1 })),
  // One dot goes round the edge.
  background: { tone: "quiet", period: 3200, light: (point, at) => (point.ring < 2 ? 0.16 : 0.2 + 0.8 * bell(between(point.angle, TAU - TAU * at), 0.5)) },
  // A pull request: the cube's edge while it is open, the whole cube once merged, the edge in grey when closed.
  open: still("ok", (point) => (point.ring === 2 ? 1 : 0.05)),
  merged: still("ok", () => 1),
  closed: still("quiet", (point) => (point.ring === 2 ? 0.8 : 0.05)),
};

/** How many moments of a loop a moving mark keeps; the apps glide between them. */
const MOMENTS = 24;

/**
 * How much of its colour a dot wears: whole where it is lit, with a slow drift across the mark so the cube is never
 * one flat colour. A finished cube is whole, and one paler sheen crosses it now and then.
 */
function rampAt(kind: ThreadMarkKind, point: CubePoint, light: number, at: number): number {
  if (kind === "done") return 1 - 0.6 * bell(point.across * 0.6 + point.down * 0.4 - (at / 0.4) * 1.4 + 0.2, 0.22);
  const drift = 0.5 + 0.5 * Math.sin(TAU * (at + point.across * 0.6 - point.down * 0.4));
  return clamp(light * 0.7 + drift * 0.3);
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

function motionOf(kind: ThreadMarkKind): MarkMotion {
  const pattern = PATTERNS[kind];
  const moments = pattern.period ? MOMENTS : 1;
  return {
    tone: pattern.tone,
    period: pattern.period,
    radius: CUBE_RADIUS,
    dots: CUBE.map((point) => ({
      x: round(point.x),
      y: round(point.y),
      frames: Array.from({ length: moments }, (_, moment) => {
        const at = moment / moments;
        const light = clamp(pattern.light(point, at));
        return { size: round(light ** 0.8), ramp: round(pattern.period ? rampAt(kind, point, light, at) : 1 - point.down * 0.7) };
      }),
    })),
  };
}

const threadMotions = new Map<ThreadMarkKind, MarkMotion>();

/** A thread state's mark. */
export function threadMarkMotion(kind: ThreadMarkKind): MarkMotion {
  let motion = threadMotions.get(kind);
  if (!motion) threadMotions.set(kind, (motion = motionOf(kind)));
  return motion;
}

/** The moment a moving mark holds when motion is reduced: the one that says most about it. */
export function restMoment(motion: MarkMotion): number {
  return motion.period ? Math.floor(motion.dots[0]!.frames.length * 0.4) : 0;
}

// Projects

/** What a project's threads are up to, as its mark shows it. */
export type ProjectActivity = "quiet" | "working" | "attention";

/**
 * A project's cube as paths in a 24 unit box: its frame, the seams between its three faces, and its top face, which
 * fills while its threads work and wears the attention colour when one needs the person.
 */
export const PROJECT_CUBE = { frame: "M12 3l8 4.5v9L12 21l-8-4.5v-9z", seams: "M4 7.5l8 4.5 8-4.5M12 12v9", top: "M12 3l8 4.5-8 4.5-8-4.5z" } as const;

// Colour

/** The colour `at` a point between two hex colours. */
export function mixHex(from: string, to: string, at: number): string {
  const channel = (hex: string, index: number): number => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return `#${[0, 1, 2]
    .map((index) =>
      Math.round(channel(from, index) + (channel(to, index) - channel(from, index)) * clamp(at))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
