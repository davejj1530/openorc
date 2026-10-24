import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function found(match: RegExpExecArray | null, what: string): string {
  if (!match?.[1]) throw new Error(`design-sync no longer finds ${what} the way it reads it`);
  return match[1];
}

/**
 * OpenOrc's mark from the desktop's OpenOrcMark.tsx (the cube's outline and its three faces), and the working mark's
 * turn from workspace-design.css: the light moves around the cube, one face at a time.
 */
export async function renderOpenOrcMark(renderer: string): Promise<string> {
  const source = await readFile(resolve(renderer, "components/OpenOrcMark.tsx"), "utf8");
  const outline = found(/const outline =\s*"([^"]+)"/.exec(source), "OpenOrcMark.tsx's outline");
  const face = (name: string) => found(new RegExp(`${name}: "([^"]+)"`).exec(source), `OpenOrcMark.tsx's ${name} face`);
  const css = await readFile(resolve(renderer, "workspace-design.css"), "utf8");
  const duration = Number(found(/\.openorc-mark-face \{\s*animation: openorc-mark-face (\d+)ms ease-in-out infinite;/.exec(css), "the mark's turn"));
  const delay = (name: string) => Number(found(new RegExp(`\\.openorc-mark-face\\[data-face="${name}"\\] \\{\\s*animation-delay: (-?\\d+)ms;`).exec(css), `the ${name} face's delay`));
  const keyframes = found(/@keyframes openorc-mark-face \{([\s\S]*?)\n\}/.exec(css), "the mark's keyframes");
  const stops = [...keyframes.matchAll(/((?:\d+%,?\s*)+)\{\s*opacity: ([\d.]+);\s*\}/g)].flatMap(([, at, opacity]) => at!.match(/\d+/g)!.map((percent) => [Number(percent), Number(opacity)]));
  if (stops.length < 2) throw new Error("design-sync no longer finds the mark's keyframes the way it reads them");
  const mark = {
    outline,
    faces: { top: face("top"), right: face("right"), left: face("left") },
    turn: { durationMs: duration, delayMs: { top: 0, right: delay("right"), left: delay("left") }, stops },
  };
  return `export const openOrcMark = ${JSON.stringify(mark)} as const;`;
}
