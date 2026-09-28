import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { detectProjectStack, STACK_SCAN_LIMITS } from "./project-stack";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "project-stack-"));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  return root;
}

it.each([
  ["react", { react: "19" }],
  ["nextjs", { next: "15", react: "19" }],
  ["nestjs", { "@nestjs/core": "11", "@nestjs/common": "11", express: "5" }],
  ["vue", { vue: "3" }],
  ["nuxt", { nuxt: "4", vue: "3" }],
  ["svelte", { svelte: "5", "@sveltejs/kit": "2" }],
  ["astro", { astro: "5", react: "19", vue: "3", svelte: "5" }],
  ["angular", { "@angular/core": "20" }],
  ["express", { express: "5" }],
])("identifies %s from direct package metadata with framework precedence", async (expected, dependencies) => {
  const root = await fixture({ "package.json": JSON.stringify({ dependencies, devDependencies: { typescript: "5" } }) });
  expect(await detectProjectStack(root)).toBe(expected);
});

it.each([
  ["laravel", "composer.json", JSON.stringify({ require: { "laravel/framework": "^12" } })],
  ["django", "requirements.txt", "# dependencies\nDjango>=5.2\npsycopg[binary]>=3\n"],
  ["fastapi", "pyproject.toml", '[project]\nname = "service"\ndependencies = [\n "fastapi[standard]>=0.115",\n]\n[tool.ruff]\nline-length = 100\n'],
  ["django", "pyproject.toml", '[tool.poetry.dependencies]\npython = "^3.12"\ndjango = "^5"\n'],
  ["fastapi", "setup.cfg", "[options]\ninstall_requires =\n fastapi>=0.115\n uvicorn\n[options.packages.find]\nwhere = src\n"],
])("identifies %s from %s without executing configuration", async (expected, file, contents) => {
  expect(await detectProjectStack(await fixture({ [file]: contents }))).toBe(expected);
});

it.each([
  ["javascript", "package.json", '{"name":"plain-node"}'],
  ["typescript", "package.json", '{"devDependencies":{"typescript":"5"}}'],
  ["python", "pyproject.toml", '[project]\nname = "plain-python"'],
  ["go", "go.mod", "module example.com/service"],
  ["rust", "Cargo.toml", '[package]\nname = "cli"'],
  ["java", "pom.xml", "<project/>"],
  ["csharp", "App.csproj", "<Project/>"],
  ["ruby", "Gemfile", 'source "https://rubygems.org"'],
  ["php", "composer.json", "{}"],
  ["swift", "Package.swift", "// swift-tools-version: 6.0"],
  ["c", "main.c", ""],
  ["cpp", "main.cpp", ""],
])("uses the %s language fallback from %s", async (expected, file, contents) => {
  expect(await detectProjectStack(await fixture({ [file]: contents }))).toBe(expected);
});

it("does not mistake framework mentions, types or lockfile transitives for installed frameworks", async () => {
  const root = await fixture({
    "package.json": JSON.stringify({ description: "react", scripts: { test: "react" }, devDependencies: { "@types/react": "19", "eslint-plugin-react": "7" } }),
    "pnpm-lock.yaml": "react: 19\nnext: 15\n",
  });
  expect(await detectProjectStack(root)).toBe("javascript");
  const python = await fixture({ "pyproject.toml": '[project]\nname = "fastapi-demo"\ndescription = "django"\n[tool.notes]\nexamples = ["fastapi"]' });
  expect(await detectProjectStack(python)).toBe("python");
});

it.each<Record<string, string>>([
  { "package.json": '{"dependencies":{"react":"19","@nestjs/core":"11"}}' },
  { "requirements.txt": "django\nfastapi\n" },
  { "pyproject.toml": '[project]\ndependencies = ["fastapi[standard]", "django>=5"]' },
  { "go.mod": "", "Cargo.toml": "" },
  { "package.json": '{"workspaces":["apps/*"],"devDependencies":{"react":"19"}}' },
  { "package.json": '{"dependencies":{"react":"19"}}', "pnpm-workspace.yaml": "packages: [apps/*]" },
  { "main.py": "", "main.go": "" },
])("keeps ambiguous roots on the folder fallback (%j)", async (files) => {
  expect(await detectProjectStack(await fixture(files))).toBeNull();
});

it("does not walk subprojects, dependencies or symlinks", async () => {
  const root = await fixture({ "apps/web/package.json": '{"dependencies":{"next":"15"}}', "node_modules/react/package.json": '{"name":"react"}' });
  const external = await fixture({ "package.json": '{"dependencies":{"react":"19"}}' });
  await symlink(path.join(external, "package.json"), path.join(root, "package.json"));
  expect(await detectProjectStack(root)).toBeNull();
});

it("ignores malformed and oversized manifests and bounds the root listing", async () => {
  expect(await detectProjectStack(await fixture({ "package.json": "{broken" }))).toBeNull();
  expect(await detectProjectStack(await fixture({ "package.json": " ".repeat(STACK_SCAN_LIMITS.manifestBytes + 1) }))).toBeNull();
  const root = await fixture(Object.fromEntries(Array.from({ length: STACK_SCAN_LIMITS.entries + 1 }, (_, i) => [`file-${i}.ts`, ""])));
  expect(await detectProjectStack(root)).toBeNull();
});

it("uses plain root source extensions, excluding configuration and test files", async () => {
  expect(await detectProjectStack(await fixture({ "main.ts": "", "helper.js": "", "vite.config.js": "" }))).toBe("typescript");
  expect(await detectProjectStack(await fixture({ "main.cpp": "", "helper.c": "" }))).toBe("cpp");
  expect(await detectProjectStack(await fixture({ "vite.config.ts": "", "app.test.ts": "", "types.d.ts": "" }))).toBeNull();
  expect(await detectProjectStack(await fixture({ "README.constructor": "" }))).toBeNull();
});
