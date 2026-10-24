import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { ComponentType, ReactElement } from "react";
import { svgPathBbox } from "svg-path-bbox";

/** The desktop's root `<svg>` attributes. The phone's icon factory sets the same ones, so a change here must reach it. */
const desktopRoot = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "1.75",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
};
const rootOnly = new Set(["xmlns", "width", "height", "aria-hidden", "focusable", "class", "data-icon", ...Object.keys(desktopRoot)]);

const elements: Record<string, string> = { path: "Path", rect: "Rect", circle: "Circle", ellipse: "Ellipse", g: "G" };
const attributes: Record<string, string> = {
  d: "d",
  x: "x",
  y: "y",
  width: "width",
  height: "height",
  rx: "rx",
  ry: "ry",
  cx: "cx",
  cy: "cy",
  r: "r",
  fill: "fill",
  stroke: "stroke",
  "fill-rule": "fillRule",
  "clip-rule": "clipRule",
  "stroke-width": "strokeWidth",
  "stroke-dasharray": "strokeDasharray",
  transform: "transform",
};

type Node = { tag: string; attributes: Record<string, string>; children: Node[] };

const unescape = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Parses React DOM's static SVG markup. It is machine-written (tags and quoted attributes only), so anything else fails. */
function parseMarkup(markup: string, name: string): Node {
  const tag = /<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z:-]+="[^"]*")*)\s*(\/?)>/gy;
  const stack: Node[] = [{ tag: "#root", attributes: {}, children: [] }];
  let match: RegExpExecArray | null;
  while (tag.lastIndex < markup.length && (match = tag.exec(markup))) {
    const [, closing, tagName, attributeText, selfClosing] = match as unknown as [string, string, string, string, string];
    if (closing) {
      if (stack.pop()?.tag !== tagName) throw new Error(`${name}: unbalanced </${tagName}>`);
      continue;
    }
    const node: Node = { tag: tagName, attributes: {}, children: [] };
    for (const [, key, value] of attributeText.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)) node.attributes[key!] = unescape(value!);
    stack.at(-1)!.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (tag.lastIndex !== markup.length || stack.length !== 1) throw new Error(`${name}: markup design-sync cannot read: ${markup}`);
  const [svg] = stack[0]!.children;
  if (svg?.tag !== "svg" || stack[0]!.children.length !== 1) throw new Error(`${name}: expected one <svg> root`);
  for (const [key, value] of Object.entries(desktopRoot)) {
    if (svg.attributes[key] !== value) throw new Error(`${name}: root ${key}="${svg.attributes[key]}" no longer matches the phone's icon factory (${value})`);
  }
  return svg;
}

/** `inset(top right bottom left)` in percentages of the element's box, as a clip rectangle in the 24-unit grid. */
function insetClip(style: string, d: string | undefined, name: string): { x: number; y: number; width: number; height: number } {
  const inset = /^clip-path:inset\(([^)]+)\)$/.exec(style)?.[1]?.split(/\s+/);
  if (!inset || !d) throw new Error(`${name}: only a path's clip-path: inset() style is supported, got "${style}"`);
  const [top, right = top, bottom = top, left = right] = inset.map((value) => {
    if (value === "0") return 0;
    if (!value.endsWith("%")) throw new Error(`${name}: inset() takes percentages here, got ${value}`);
    return Number(value.slice(0, -1)) / 100;
  }) as [number, number?, number?, number?];
  // CSS clips an SVG element against its own bounding box.
  const [minX, minY, maxX, maxY] = svgPathBbox(d);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const width = maxX - minX;
  const height = maxY - minY;
  return { x: round(minX + width * left!), y: round(minY + height * top), width: round(width * (1 - left! - right!)), height: round(height * (1 - top - bottom!)) };
}

type Rendered = { jsx: string; clips: string[]; toned: boolean };

function toJsx(node: Node, name: string, out: Rendered): string {
  const component = elements[node.tag];
  if (!component) throw new Error(`${name}: <${node.tag}> has no react-native-svg mapping`);
  const props: string[] = [];
  for (const [key, value] of Object.entries(node.attributes)) {
    if (key === "style") {
      const id = `${name}-clip-${out.clips.length}`;
      const box = insetClip(value, node.attributes.d, name);
      out.clips.push(`<ClipPath id="${id}"><Rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" /></ClipPath>`);
      props.push(`clipPath="url(#${id})"`);
      continue;
    }
    const prop = attributes[key];
    if (!prop) throw new Error(`${name}: attribute ${key} has no react-native-svg mapping`);
    const token = /^var\(--([a-z0-9-]+)\)$/.exec(value)?.[1];
    if (token) out.toned = true;
    props.push(token ? `${prop}={tone("${token}")}` : `${prop}=${JSON.stringify(value)}`);
  }
  const children = node.children.map((child) => toJsx(child, name, out)).join("");
  return children ? `<${component} ${props.join(" ")}>${children}</${component}>` : `<${component} ${props.join(" ")} />`;
}

/** One icon's declaration in the generated module, through `icon` or, when it paints a palette role, `tonedIcon`. */
function declaration(name: string, svg: Node): string {
  for (const key of Object.keys(svg.attributes)) if (!rootOnly.has(key)) throw new Error(`${name}: root attribute ${key} is not mapped`);
  const out: Rendered = { jsx: "", clips: [], toned: false };
  const body = svg.children.map((child) => toJsx(child, name, out)).join("");
  const defs = out.clips.length ? `<Defs>${out.clips.join("")}</Defs>` : "";
  const geometry = defs || svg.children.length > 1 ? `<>${defs}${body}</>` : body;
  return out.toned ? `export const ${name} = tonedIcon("${name}", (tone) => (${geometry}));` : `export const ${name} = icon("${name}", ${geometry});`;
}

/**
 * Renders every export of the desktop's icons.tsx with React DOM, as scripts/icon-preview.mts does, into a module of
 * react-native-svg components with the same names.
 */
export async function renderIcons(desktop: string): Promise<string> {
  // The desktop's own React renders its components.
  const require = createRequire(resolve(desktop, "package.json"));
  const { createElement } = require("react") as typeof import("react");
  const { renderToStaticMarkup } = require("react-dom/server") as { renderToStaticMarkup: (element: ReactElement) => string };
  const icons = (await import(resolve(desktop, "src/renderer/src/components/icons.tsx"))) as Record<string, ComponentType<{ size?: number }>>;
  const names = Object.keys(icons)
    .filter((name) => name !== "default" && name !== "module.exports")
    .sort();
  const declarations = names.map((name) => declaration(name, parseMarkup(renderToStaticMarkup(createElement(icons[name]!, { size: 24 })), name)));
  const used = new Set(
    declarations
      .join("\n")
      .match(/<([A-Z][A-Za-z]*)/g)
      ?.map((tag) => tag.slice(1)),
  );
  const imports = ["ClipPath", "Defs", ...Object.values(elements)].filter((component) => used.has(component)).sort();
  const factories = ["icon", ...(declarations.some((line) => line.includes("tonedIcon(")) ? ["tonedIcon"] : [])];
  return [`import { ${imports.join(", ")} } from "react-native-svg";`, `import { ${factories.join(", ")} } from "../ui/icon";`, "", ...declarations].join("\n");
}
