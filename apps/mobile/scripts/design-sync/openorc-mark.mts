import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function found(match: RegExpExecArray | null, what: string): string {
  if (!match?.[1]) throw new Error(`design-sync no longer finds ${what} the way it reads it`);
  return match[1];
}

/**
 * OpenOrc's mark from the desktop's OpenOrcMark.tsx (the cube's outline and its three faces), and the working mark's
 * turn: the light moves around the cube, one face at a time. The desktop names the lit face on a clock (how long a face
 * has, when the first hands over, and in which order) and its stylesheet crosses to it; the phone plays the same turn
 * as one loop a face, each started a face later.
 */
export async function renderOpenOrcMark(renderer: string): Promise<string> {
  const source = await readFile(resolve(renderer, "components/OpenOrcMark.tsx"), "utf8");
  const outline = found(/const outline =\s*"([^"]+)"/.exec(source), "OpenOrcMark.tsx's outline");
  const face = (name: string) => found(new RegExp(`${name}: "([^"]+)"`).exec(source), `OpenOrcMark.tsx's ${name} face`);
  const turn = Number(found(/const TURN_MS = (\d+);/.exec(source), "how long a face is lit"));
  const firstCross = Number(found(/const CROSS_AT_MS = (\d+);/.exec(source), "when the first face hands over"));
  const order = [...found(/const LIT_ORDER = \[([^\]]+)\]/.exec(source), "the order the faces light in").matchAll(/"(\w+)"/g)].map(([, name]) => name!);
  if (order.join() !== "top,right,left") throw new Error(`design-sync reads the faces lit top, right, left; the desktop lights ${order.join(", ")}`);
  const css = await readFile(resolve(renderer, "workspace-design.css"), "utf8");
  const cross = Number(found(/\.openorc-mark-face \{\s*transition: opacity (\d+)ms ease-in-out;/.exec(css), "the mark's cross"));
  const durationMs = turn * order.length;
  const at = (ms: number) => Math.round((ms / durationMs) * 100);
  const mark = {
    outline,
    faces: { top: face("top"), right: face("right"), left: face("left") },
    turn: {
      durationMs,
      // Each face runs the top's loop, begun as many faces ago as it is from its own turn.
      delayMs: { top: 0, right: turn - durationMs, left: 2 * turn - durationMs },
      stops: [
        [0, 1],
        [at(firstCross), 1],
        [at(firstCross + cross), 0],
        [at(durationMs - cross), 0],
      ],
    },
  };
  return `export const openOrcMark = ${JSON.stringify(mark)} as const;`;
}
