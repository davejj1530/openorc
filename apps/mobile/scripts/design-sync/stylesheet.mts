import postcss, { type AtRule, type Root, type Rule } from "postcss";
import type { Cascade, Declarations } from "./colors.mts";

export type TextStep = { size: number; lineHeight: number; letterSpacing: number };
export type Bezier = [number, number, number, number];
export type Scales = {
  text: Record<string, TextStep>;
  radius: Record<string, number>;
  /** Tailwind height utilities over the control ramp, named as the desktop's `@theme inline` names them. */
  height: Record<string, number>;
  /** The desktop's reading measures, which cap a column on a screen wider than a phone's. */
  container: Record<string, number>;
  motion: { ease: Record<string, Bezier>; duration: Record<string, number>; stagger: number; arrive: Record<string, number> };
};

/** A block's custom properties. Ordinary properties such as color-scheme are not tokens. */
function declarations(node: Rule | AtRule): Record<string, string> {
  const found: Record<string, string> = {};
  node.each((child) => {
    if (child.type === "decl" && child.prop.startsWith("--")) found[child.prop] = child.value;
  });
  return found;
}

function topLevelRule(root: Root, selector: string): Declarations {
  const rule = root.nodes.find((node): node is Rule => node.type === "rule" && node.selector === selector);
  if (!rule) throw new Error(`app.css has no top-level ${selector} rule`);
  return declarations(rule);
}

function themeBlock(root: Root, params: string): Declarations {
  const block = root.nodes.find((node): node is AtRule => node.type === "atrule" && node.name === "theme" && node.params === params);
  if (!block) throw new Error(`app.css has no @theme ${params} block`);
  return declarations(block);
}

const unit = (suffix: string) => (value: string, name: string) => {
  const match = new RegExp(`^(-?\\d*\\.?\\d+)${suffix}$`).exec(value.trim());
  if (!match) throw new Error(`${name}: expected a ${suffix || "unitless"} value, got "${value}"`);
  return Number(match[1]);
};
const px = unit("px");
const ms = unit("ms");
const em = (value: string, name: string) => (value.trim() === "0" ? 0 : unit("em")(value, name));

function bezier(value: string, name: string): Bezier {
  const match = /^cubic-bezier\(([^)]+)\)$/.exec(value.trim());
  const points = match?.[1]!.split(",").map(Number);
  if (!points || points.length !== 4 || points.some(Number.isNaN)) throw new Error(`${name}: expected cubic-bezier(), got "${value}"`);
  return points as Bezier;
}

type Families = Omit<Scales, "height" | "container" | "text"> & { control: Record<string, number> };

/** The phone's type steps from its own `@theme static` block: each a size, a line height and tracking in points. */
function readType(declarations: Declarations): Scales["text"] {
  const text: Scales["text"] = {};
  for (const [name, value] of Object.entries(declarations)) {
    if (!name.startsWith("--text-")) throw new Error(`type-scale.css: ${name} is not a type step`);
    const [key, part] = name.slice("--text-".length).split("--") as [string, string | undefined];
    const entry = (text[key] ??= { size: 0, lineHeight: 0, letterSpacing: 0 });
    if (part === undefined) entry.size = px(value, name);
    else if (part === "line-height") entry.lineHeight = px(value, name);
    // Kept in em until every step's size is known; React Native tracking is absolute.
    else if (part === "letter-spacing") entry.letterSpacing = em(value, name);
    else throw new Error(`${name}: unknown text property`);
  }
  for (const [name, step] of Object.entries(text)) {
    if (!step.size || !step.lineHeight) throw new Error(`--text-${name} needs a size and a line height`);
    step.letterSpacing = Math.round(step.letterSpacing * step.size * 1000) / 1000;
  }
  return text;
}

/**
 * Each `@theme static` family the phone reads, by prefix. A declaration matching none of them fails the run, so a new
 * desktop scale is a decision here rather than a silent gap.
 */
const families: { prefix: string; read: (families: Families, step: string, value: string, name: string) => void }[] = [
  // The phone sets its own type (src/type-scale.css): its sizes are a phone's, not a window's.
  { prefix: "--text-", read: () => undefined },
  {
    prefix: "--radius-",
    read: ({ radius }, step, value, name) => {
      radius[step] = px(value, name);
    },
  },
  {
    prefix: "--control-",
    read: ({ control }, step, value, name) => {
      control[step] = px(value, name);
    },
  },
  {
    prefix: "--ease-",
    read: ({ motion }, step, value, name) => {
      motion.ease[step] = bezier(value, name);
    },
  },
  {
    prefix: "--duration-",
    read: ({ motion }, step, value, name) => {
      motion.duration[step] = ms(value, name);
    },
  },
  {
    prefix: "--stagger",
    read: ({ motion }, _step, value, name) => {
      motion.stagger = ms(value, name);
    },
  },
  {
    prefix: "--arrive-",
    read: ({ motion }, step, value, name) => {
      motion.arrive[step] = px(value, name);
    },
  },
  // The phone embeds its own faces (fonts.mts) and has one interface weight, as the desktop does.
  { prefix: "--font-", read: () => undefined },
];

function readScales(statics: Declarations, inline: Declarations, type: Declarations): Scales {
  const read: Families = { radius: {}, control: {}, motion: { ease: {}, duration: {}, stagger: 0, arrive: {} } };
  for (const [name, value] of Object.entries(statics)) {
    const family = families.find(({ prefix }) => name.startsWith(prefix));
    if (!family) throw new Error(`app.css @theme static: ${name} belongs to no scale design-sync knows`);
    family.read(read, name.slice(family.prefix.length), value, name);
  }
  const height: Record<string, number> = {};
  for (const [name, value] of Object.entries(inline)) {
    const control = /^var\(--control-([a-z-]+)\)$/.exec(value.trim())?.[1];
    if (!name.startsWith("--height-") || !control) continue;
    const size = read.control[control];
    if (size === undefined) throw new Error(`${name} points at --control-${control}, which @theme static does not define`);
    height[name.slice("--height-".length)] = size;
  }
  const container: Record<string, number> = {};
  for (const [name, value] of Object.entries(inline)) {
    if (name.startsWith("--container-")) container[name.slice("--container-".length)] = px(value, name);
  }
  const { control: _control, ...scales } = read;
  return { ...scales, text: readType(type), height, container };
}

/**
 * Everything the phone reads from the stylesheets: from the desktop's app.css the cascade under every palette and the
 * scales, and from the phone's own type-scale.css its type.
 */
export function readStylesheet(app: { css: string; from: string }, type: { css: string; from: string }): { cascade: Cascade; scales: Scales } {
  const root = postcss.parse(app.css, { from: app.from });
  return {
    cascade: { root: topLevelRule(root, ":root"), dark: topLevelRule(root, ':root[data-theme="dark"]') },
    scales: readScales(themeBlock(root, "static"), themeBlock(root, "inline"), themeBlock(postcss.parse(type.css, { from: type.from }), "static")),
  };
}
