import { opendir, realpath } from "node:fs/promises";
import path from "node:path";
import type { ProjectStackIconId } from "../shared/project-stack-icons";
import { containedFile, readSmallFile } from "./project-icon-discovery";

export const STACK_SCAN_LIMITS = { entries: 256, manifestBytes: 64 * 1024 };
const metadataNames = ["package.json", "composer.json", "pyproject.toml", "requirements.txt", "setup.cfg"] as const;
const nodeFrameworks: ReadonlyArray<[ProjectStackIconId, string[]]> = [
  ["nextjs", ["next"]],
  ["nestjs", ["@nestjs/core"]],
  ["nuxt", ["nuxt"]],
  ["svelte", ["svelte", "@sveltejs/kit"]],
  ["astro", ["astro"]],
  ["angular", ["@angular/core"]],
  ["react", ["react"]],
  ["vue", ["vue"]],
  ["express", ["express"]],
];
const languageFiles: ReadonlyArray<[ProjectStackIconId, RegExp]> = [
  ["python", /^(pyproject\.toml|requirements\.txt|setup\.(py|cfg)|Pipfile)$/],
  ["go", /^go\.mod$/],
  ["rust", /^Cargo\.toml$/],
  ["java", /^(pom\.xml|build\.gradle(?:\.kts)?)$/],
  ["csharp", /\.csproj$/],
  ["ruby", /^(Gemfile|.+\.gemspec)$/],
  ["php", /^composer\.json$/],
  ["swift", /^Package\.swift$/],
];
const extensions: Record<string, ProjectStackIconId> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function json(text: string): Record<string, unknown> {
  try {
    return object(JSON.parse(text));
  } catch {
    return {};
  }
}

/** Only regular root entries, never dependencies, child projects or linked files. */
async function rootFiles(root: string): Promise<Set<string>> {
  const files = new Set<string>();
  const directory = await opendir(root);
  let entries = 0;
  for await (const entry of directory) {
    if (++entries > STACK_SCAN_LIMITS.entries) return new Set(); // Truncated evidence is ambiguous.
    if (entry.isFile()) files.add(entry.name);
  }
  return files;
}

async function metadata(root: string, files: Set<string>): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const name of metadataNames) {
    if (!files.has(name)) continue;
    try {
      const file = await containedFile(root, path.join(root, name));
      texts.set(name, (await readSmallFile(file, STACK_SCAN_LIMITS.manifestBytes)).toString("utf8"));
    } catch {
      /* Missing, linked outside, oversized or malformed metadata is not evidence. */
    }
  }
  return texts;
}

function nodeStack(pkg: Record<string, unknown>, files: Set<string>, frameworks: Set<ProjectStackIconId>, languages: Set<ProjectStackIconId>): void {
  if (!Object.keys(pkg).length) return;
  const dependencies = { ...object(pkg["dependencies"]), ...object(pkg["devDependencies"]) };
  for (const [id, names] of nodeFrameworks) {
    if (names.some((name) => typeof dependencies[name] === "string")) frameworks.add(id);
  }
  // A framework's normal dependencies should not make its own stack ambiguous.
  if (frameworks.has("nextjs")) frameworks.delete("react");
  if (frameworks.has("nuxt")) frameworks.delete("vue");
  if (frameworks.has("nestjs")) frameworks.delete("express");
  if (frameworks.has("astro")) {
    frameworks.delete("react");
    frameworks.delete("vue");
    frameworks.delete("svelte");
  }
  languages.add(files.has("tsconfig.json") || typeof dependencies["typescript"] === "string" ? "typescript" : "javascript");
}

function pythonStack(texts: Map<string, string>, frameworks: Set<ProjectStackIconId>): void {
  const requirements = texts.get("requirements.txt") ?? "";
  const pyproject = texts.get("pyproject.toml") ?? "";
  const project = pyproject.match(/^\[project\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? "";
  // Keep extras such as "fastapi[standard]" inside strings; a closing bracket there is not the array end.
  const dependencies = (project.match(/^\s*dependencies\s*=\s*\[((?:\s|,|#[^\r\n]*|"[^"\r\n]*"|'[^'\r\n]*')*)\]/m)?.[1] ?? "").replace(/#[^\r\n]*/g, "");
  const poetry = pyproject.match(/^\[tool\.poetry\.dependencies\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? "";
  const setup = (texts.get("setup.cfg") ?? "").match(/^\s*install_requires\s*=([^]*?)(?=^\S|$(?![\s\S]))/m)?.[1] ?? "";
  for (const id of ["django", "fastapi"] as const) {
    const requirement = new RegExp(`^\\s*${id}(?:[<>=!~;\\[\\s@]|$)`, "im");
    const quoted = new RegExp(`["']${id}(?:[<>=!~;\\[\\s"']|$)`, "i");
    const key = new RegExp(`^\\s*["']?${id}["']?\\s*=`, "im");
    if (requirement.test(requirements) || requirement.test(setup) || quoted.test(dependencies) || key.test(poetry)) frameworks.add(id);
  }
}

function sourceLanguage(files: Set<string>): ProjectStackIconId | null {
  const languages = new Set<ProjectStackIconId>();
  for (const name of files) {
    if (/(?:^|\.)(?:config|test|spec|d)\.[^.]+$/.test(name)) continue;
    const extension = path.extname(name).slice(1);
    if (Object.hasOwn(extensions, extension)) languages.add(extensions[extension]!);
  }
  if (languages.has("typescript")) languages.delete("javascript");
  if (languages.has("cpp")) languages.delete("c");
  return languages.size === 1 ? [...languages][0]! : null;
}

/** Five bounded metadata reads at most. No source walk, config execution, network or model. */
export async function detectProjectStack(rootPath: string): Promise<ProjectStackIconId | null> {
  try {
    const root = await realpath(rootPath);
    const files = await rootFiles(root);
    const texts = await metadata(root, files);
    const pkg = json(texts.get("package.json") ?? "");
    // Workspace tooling is not evidence of one application/framework for the whole repository.
    if (pkg["workspaces"] || files.has("pnpm-workspace.yaml") || files.has("lerna.json")) return null;
    const frameworks = new Set<ProjectStackIconId>();
    const languages = new Set<ProjectStackIconId>();
    nodeStack(pkg, files, frameworks, languages);
    const composer = json(texts.get("composer.json") ?? "");
    if (typeof object(composer["require"])["laravel/framework"] === "string") frameworks.add("laravel");
    pythonStack(texts, frameworks);
    if (frameworks.size) return frameworks.size === 1 ? [...frameworks][0]! : null;
    for (const [language, pattern] of languageFiles) {
      if ([...files].some((file) => pattern.test(file))) languages.add(language);
    }
    if (languages.size) return languages.size === 1 ? [...languages][0]! : null;
    return sourceLanguage(files);
  } catch {
    return null;
  }
}
