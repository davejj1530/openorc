import { compile } from "@tailwindcss/node";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { colors } from "../src/generated/tokens.ts";

const src = resolve(import.meta.dirname, "../src");
const stylesheet = join(src, "global.css");
const COMPARISONS = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken]);

/** Each class a view names, with a file that names it: the strings of a `…className` prop and of `cn(…)` calls. */
async function namedClasses(): Promise<Map<string, string>> {
  const classes = new Map<string, string>();
  const files = (await readdir(src, { recursive: true })).filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.startsWith("test-fixtures"));
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(join(src, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const collect = (node: ts.Node): void => {
      // The value a condition compares (`status === "failed" && "text-bad"`) is not a class.
      if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) return;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) for (const name of node.text.split(/\s+/).filter(Boolean)) classes.set(name, file);
      ts.forEachChild(node, collect);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && /className$/i.test(node.name.getText()) && node.initializer) collect(node.initializer);
      else if (ts.isCallExpression(node) && node.expression.getText() === "cn") collect(node);
      else ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return classes;
}

/** The stylesheet as the bundler compiles it: Uniwind registers the themes' colors in its own stylesheet as Metro starts. */
async function compiler() {
  const themeColors = Object.keys(colors.light).map((token) => `--color-${token}: unset;`);
  const css = `${await readFile(stylesheet, "utf8")}\n@theme {\n${themeColors.join("\n")}\n}`;
  return compile(css, { base: dirname(stylesheet), onDependency: () => undefined });
}

it("gives every class the views name a style, so none silently draws nothing", async () => {
  const tailwind = await compiler();
  let css = tailwind.build([]);
  const empty: string[] = [];
  for (const [name, file] of await namedClasses()) {
    const next = tailwind.build([name]);
    if (next === css) empty.push(`${name} (${file})`);
    css = next;
  }
  expect(empty).toEqual([]);
});
