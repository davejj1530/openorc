import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** The SVG features the provider marks use; anything else fails, so a new mark cannot render wrong on the phone. */
const pathAttributes: Record<string, string> = { d: "d", fill: "fill", "fill-rule": "fillRule", "clip-rule": "clipRule" };

type Mark = { viewBox: string; paths: Record<string, string>[]; invertsInDark: boolean };

function attributesOf(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)].map(([, key, value]) => [key!, value!]));
}

function readMark(svg: string, name: string, invertsInDark: boolean): Mark {
  const body = svg.replace(/<!--[\s\S]*?-->/g, "").trim();
  const root = /^<svg\s([^>]*)>([\s\S]*)<\/svg>$/.exec(body);
  if (!root) throw new Error(`${name}: expected one <svg> root`);
  const viewBox = attributesOf(root[1]!)["viewBox"];
  if (!viewBox) throw new Error(`${name}: the <svg> root has no viewBox`);
  const elements = root[2]!.trim();
  const paths = [...elements.matchAll(/<path\s([^>]*?)\s*\/?>(?:<\/path>)?/g)];
  if (
    paths
      .map(([match]) => match)
      .join("")
      .replace(/\s/g, "") !== elements.replace(/\s/g, "")
  )
    throw new Error(`${name}: only <path> elements are supported`);
  return {
    viewBox,
    invertsInDark,
    paths: paths.map(([, text]) =>
      Object.fromEntries(
        Object.entries(attributesOf(text!)).map(([key, value]) => {
          const prop = pathAttributes[key];
          if (!prop) throw new Error(`${name}: path attribute ${key} has no react-native-svg mapping`);
          return [prop, value];
        }),
      ),
    ),
  };
}

/**
 * The harness marks from the desktop's assets/providers, as path data the phone draws with react-native-svg. Marks the
 * desktop inverts in dark themes (its `.harness-logo[data-provider=…]` rules in app.css) are flagged to invert too.
 */
export async function renderHarnessLogos(renderer: string, appCss: string): Promise<string> {
  const source = await readFile(resolve(renderer, "components/HarnessLogo.tsx"), "utf8");
  const files = [...source.matchAll(/import (\w+) from "\.\.\/assets\/providers\/([\w-]+\.svg)";/g)].map(([, variable, file]) => ({ variable: variable!, file: file! }));
  const mapping = /harnessLogos = \{([^}]*)\}/.exec(source)?.[1];
  if (!files.length || !mapping) throw new Error("HarnessLogo.tsx no longer imports provider marks the way design-sync reads them");
  const inverted = new Set([...appCss.matchAll(/\.harness-logo\[data-provider="([a-z]+)"\]/g)].map(([, id]) => id!));
  const marks: Record<string, Mark> = {};
  for (const [, id, variable] of mapping.matchAll(/(\w+): (\w+)/g)) {
    const file = files.find((entry) => entry.variable === variable);
    if (!file) throw new Error(`HarnessLogo.tsx maps ${id} to ${variable}, which it does not import`);
    marks[id!] = readMark(await readFile(resolve(renderer, "assets/providers", file.file), "utf8"), file.file, inverted.has(id!));
  }
  return [
    'import type { HarnessId } from "@openorc/protocol";',
    "",
    `export const harnessMarks = ${JSON.stringify(marks)} as const satisfies Record<HarnessId, { viewBox: string; paths: readonly Record<string, string>[]; invertsInDark: boolean }>;`,
  ].join("\n");
}
