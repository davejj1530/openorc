import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The code colors the phone's Markdown takes, by its own token kinds, each read as a TextMate scope. */
const kinds = {
  keyword: "keyword.control",
  operator: "keyword.operator",
  punctuation: "punctuation.separator",
  string: "string.quoted",
  number: "constant.numeric",
  constant: "constant.language",
  comment: "comment.line",
  function: "entity.name.function",
  type: "entity.name.type",
  variable: "variable.other",
  property: "support.type.property-name",
  tag: "entity.name.tag",
  attribute: "entity.other.attribute-name",
  embedded: "meta.embedded",
} as const;

type Theme = { type: "light" | "dark"; colors?: Record<string, string>; tokenColors: { scope?: string | string[]; settings: { foreground?: string } }[] };

/** TextMate matching, as far as code colors need it: the longest rule that is a whole-segment prefix of the scope. */
function colorFor(theme: Theme, scope: string): string {
  let best: { length: number; color: string } | null = null;
  for (const rule of theme.tokenColors) {
    const color = rule.settings.foreground;
    if (!color) continue;
    for (const selector of [rule.scope ?? []].flat()) {
      if (selector.includes(" ")) continue;
      if ((scope === selector || scope.startsWith(`${selector}.`)) && (!best || selector.length > best.length)) best = { length: selector.length, color };
    }
  }
  const color = best?.color ?? theme.colors?.["editor.foreground"];
  if (!color) throw new Error(`no color for ${scope}`);
  return color.toLowerCase();
}

/** A package as Node finds it from `from`: the nearest node_modules above holding it. These packages export ESM only. */
function packageDir(from: string, name: string): string {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`design-sync cannot find ${name} from ${from}`);
}

/**
 * The desktop's code themes (the Shiki themes RichText.tsx gives Streamdown's code plugin), read through the same
 * packages the desktop resolves, and mapped to the phone's token kinds per mode.
 */
export async function readSyntax(desktop: string): Promise<Record<"light" | "dark", Record<keyof typeof kinds, string>>> {
  const source = await readFile(resolve(desktop, "src/renderer/src/components/RichText.tsx"), "utf8");
  const names = /createCodePlugin\(\{ themes: \["([\w-]+)", "([\w-]+)"\] \}\)/.exec(source);
  if (!names) throw new Error("RichText.tsx no longer names its code themes the way design-sync reads them");
  const shiki = packageDir(packageDir(desktop, "@streamdown/code"), "shiki");
  const themesDir = packageDir(shiki, "@shikijs/themes");
  const exports = (JSON.parse(await readFile(join(themesDir, "package.json"), "utf8")) as { exports: Record<string, string> }).exports;
  const themes = await Promise.all(
    names.slice(1).map(async (name) => {
      const file = exports[`./${name}`];
      if (!file) throw new Error(`@shikijs/themes has no ${name}`);
      return ((await import(pathToFileURL(resolve(themesDir, file)).href)) as { default: Theme }).default;
    }),
  );
  const byMode = Object.fromEntries(themes.map((theme) => [theme.type, Object.fromEntries(Object.entries(kinds).map(([kind, scope]) => [kind, colorFor(theme, scope)]))]));
  if (!byMode["light"] || !byMode["dark"]) throw new Error("RichText.tsx's code themes are not one light and one dark");
  return byMode as Record<"light" | "dark", Record<keyof typeof kinds, string>>;
}
