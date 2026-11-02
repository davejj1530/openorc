import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { editorText, FolderPath, type EditorDocument, type EditorQuery } from "@openorc/protocol";
import { TypeScriptIntelligence } from "./typescript-intelligence.js";

let root: string;
let engine: TypeScriptIntelligence;
const math = "/** Double a value. */\nexport function double(value: number): number { return value * 2; }\n";
const main = 'import { double } from "./math.js";\nconst result = double(2);\n';
const document = (path: string, text: string): EditorDocument => ({ path: FolderPath.parse(path), text });
const query = (request: EditorQuery, text = main, more: EditorDocument[] = []) =>
  engine.query({ root, path: FolderPath.parse("main.ts"), documents: [document("main.ts", text), ...more], query: request });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openorc-intelligence-"));
  engine = new TypeScriptIntelligence();
  await Promise.all([
    writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", types: [], skipLibCheck: true }, include: ["*.ts"] }),
    ),
    writeFile(join(root, "math.ts"), math),
    writeFile(join(root, "main.ts"), main),
  ]);
});
afterEach(async () => {
  engine.dispose();
  await rm(root, { recursive: true, force: true });
});

it("resolves imported definitions and references with exact source locations", () => {
  const position = main.lastIndexOf("double") + 2;
  const definition = query({ kind: "definition", position });
  expect(definition).toMatchObject({ kind: "definition", locations: [{ path: "math.ts", line: 2, column: 17, preview: expect.stringContaining("export function double") }] });
  const references = query({ kind: "references", position });
  expect(references.kind).toBe("references");
  if (references.kind !== "references") throw new Error("Expected references");
  expect(references.locations.map((target) => target.path)).toEqual(expect.arrayContaining(["main.ts", "math.ts"]));
});

it("shows types, documentation, parameter hints and member completion", () => {
  const position = main.lastIndexOf("double") + 2;
  expect(query({ kind: "hover", position })).toMatchObject({ kind: "hover", info: { display: expect.stringContaining("value: number"), documentation: "Double a value." } });
  expect(query({ kind: "signature", position: main.lastIndexOf("double(2") + 7 })).toMatchObject({
    kind: "signature",
    info: { parameter: "value: number", label: expect.stringContaining("double(") },
  });
  const text = 'const person = { firstName: "Ada", age: 36 };\nperson.';
  expect(query({ kind: "completion", position: text.length }, text)).toMatchObject({
    kind: "completion",
    options: expect.arrayContaining([expect.objectContaining({ label: "firstName", insertText: "firstName" })]),
  });
});

it("analyzes every unsaved buffer, drops removed overlays, and never changes files", async () => {
  const changed = math.replaceAll("number", "string").replace("value * 2", 'value + "!"');
  const dirty = query({ kind: "analysis" }, main, [document("math.ts", changed)]);
  expect(dirty).toMatchObject({ kind: "analysis", diagnostics: expect.arrayContaining([expect.objectContaining({ code: 2345 })]) });
  expect(dirty.kind === "analysis" && dirty.diagnostics.some((diagnostic) => diagnostic.code === 1261 || diagnostic.code === 1149)).toBe(false);
  const clean = query({ kind: "analysis" });
  expect(clean).toMatchObject({ kind: "analysis", diagnostics: [] });
  expect(await readFile(join(root, "math.ts"), "utf8")).toBe(math);
});

it("refreshes imported types after an external edit", async () => {
  const position = main.lastIndexOf("double") + 2;
  query({ kind: "hover", position });
  await writeFile(join(root, "math.ts"), math.replaceAll("number", "string").replace("value * 2", 'value + "!"'));
  expect(query({ kind: "hover", position })).toMatchObject({ kind: "hover", info: { display: expect.stringContaining("value: string") } });
});

it("returns diagnostics, a symbol outline and reversible quick fixes for the unsaved text", () => {
  const text = main.replace("double(2)", "dobule(2)");
  const analysis = query({ kind: "analysis" }, text);
  if (analysis.kind !== "analysis") throw new Error("Expected analysis");
  expect(analysis.symbols.map((symbol) => symbol.name)).toContain("result");
  const diagnostic = analysis.diagnostics.find((item) => item.code === 2552);
  if (!diagnostic) throw new Error("Expected a spelling diagnostic");
  expect(query({ kind: "fixes", from: diagnostic.from, to: diagnostic.to, code: diagnostic.code }, text)).toMatchObject({
    kind: "fixes",
    fixes: expect.arrayContaining([expect.objectContaining({ changes: [{ path: "main.ts", before: text, after: main }] })]),
  });
});

it("uses LF UTF-16 offsets for CRLF buffers containing emoji", () => {
  const text = 'const emoji = "🧠";\r\n' + main.replaceAll("\n", "\r\n");
  const normalized = editorText(text);
  const result = query({ kind: "references", position: normalized.lastIndexOf("double") + 2 }, text);
  if (result.kind !== "references") throw new Error("Expected references");
  expect(result.locations).toEqual(expect.arrayContaining([expect.objectContaining({ path: "main.ts", line: 3, column: 16, from: normalized.lastIndexOf("double") })]));
});

it("keeps separate worktree source files and respects tsconfig path aliases", async () => {
  const copy = join(root, "worktree");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(copy);
  await Promise.all([
    writeFile(join(copy, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@math": ["./math.ts"] }, types: [] }, include: ["*.ts"] })),
    writeFile(join(copy, "math.ts"), 'export const double = (value: string) => value + "!";'),
    writeFile(join(copy, "main.ts"), main),
  ]);
  const text = main.replace('"./math.js"', '"@math"');
  const result = engine.query({ root: copy, path: FolderPath.parse("main.ts"), documents: [document("main.ts", text)], query: { kind: "hover", position: text.lastIndexOf("double") + 2 } });
  expect(result).toMatchObject({ kind: "hover", info: { display: expect.stringContaining("value: string") } });
  expect(query({ kind: "hover", position: main.lastIndexOf("double") + 2 })).toMatchObject({ kind: "hover", info: { display: expect.stringContaining("value: number") } });
});

it("understands JavaScript files even when the surrounding tsconfig includes only TypeScript", () => {
  const text = '/** @param {string} name */\nfunction greet(name) { return name.toUpperCase(); }\ngreet("Ada");';
  const result = engine.query({ root, path: FolderPath.parse("script.js"), documents: [document("script.js", text)], query: { kind: "hover", position: text.lastIndexOf("greet") + 2 } });
  expect(result).toMatchObject({ kind: "hover", info: { display: expect.stringContaining("name: string") } });
});

it("uses the referenced web project's JSX settings for a solution-style tsconfig", async () => {
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "./tsconfig.web.json" }] }));
  await writeFile(join(root, "tsconfig.web.json"), JSON.stringify({ compilerOptions: { jsx: "preserve", types: [], strict: false }, include: ["*.tsx"] }));
  const text = "declare namespace JSX { interface IntrinsicElements { div: unknown } }\nexport const App = () => <div />;";
  await writeFile(join(root, "app.tsx"), text);
  const result = engine.query({ root, path: FolderPath.parse("app.tsx"), documents: [document("app.tsx", text)], query: { kind: "analysis" } });
  expect(result).toMatchObject({ kind: "analysis", diagnostics: [] });
});

it("supports a folder without a config while excluding generated build output", async () => {
  await rm(join(root, "tsconfig.json"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "out"));
  await writeFile(join(root, "out", "bundle.ts"), "this is generated junk");
  expect(query({ kind: "analysis" })).toMatchObject({ kind: "analysis", diagnostics: [] });
  expect(query({ kind: "references", position: main.lastIndexOf("double") + 2 })).toMatchObject({
    kind: "references",
    locations: expect.arrayContaining([expect.objectContaining({ path: "math.ts" })]),
  });
});
