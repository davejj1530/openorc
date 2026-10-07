import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FolderPath } from "@openorc/protocol";
import type { FolderKind } from "./conversation-folder.js";
import { FileFormatter } from "./file-format.js";

let dir: string;
let root: string;
let bin: string;
let marker: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "openorc-format-")));
  root = join(dir, "project");
  bin = join(dir, "bin");
  marker = join(dir, "ran");
  await mkdir(root);
  await mkdir(bin);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** An executable shell script, standing in for a formatter. Each run appends its arguments to `marker`. */
async function script(file: string, body: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\necho "$@" >> "${marker}"\n${body}\n`, { mode: 0o755 });
}

const UPPERCASE = "tr '[:lower:]' '[:upper:]'";
const login = () => ({ path: `${bin}:/usr/bin:/bin`, env: { PATH: "/usr/bin:/bin" } });
const formatter = (options: { timeoutMs?: number; env?: Record<string, string> } = {}) =>
  new FileFormatter({ bundled: null, environment: () => ({ ...login(), ...(options.env ? { env: options.env } : {}) }), timeoutMs: options.timeoutMs });
const format = (file: string, text: string, kind: FolderKind = "checkout", using = formatter()) => using.format({ root, kind }, FolderPath.parse(file), text, false);

it.each(["review", "member"] as const)("never runs a project's formatter in a %s copy", async (kind) => {
  await writeFile(join(root, ".prettierrc"), "{}\n");
  await script(join(root, "node_modules/.bin/prettier"), UPPERCASE);
  expect(await format("src/app.ts", "export {};\n", kind)).toEqual({ kind: "unavailable" });
  await expect(access(marker)).rejects.toThrow();
  expect(await format("src/app.ts", "export {};\n")).toEqual({ kind: "formatted", text: "EXPORT {};\n" });
});

it("runs a formatter the project configures but installs only on the login shell's PATH, reading the file's text from stdin", async () => {
  await writeFile(join(root, "ruff.toml"), "line-length = 100\n");
  await script(join(bin, "ruff"), UPPERCASE);
  expect(await format("pkg/main.py", "print('hi')\n")).toEqual({ kind: "formatted", text: "PRINT('HI')\n" });
  expect(await readFile(marker, "utf8")).toBe(`format --stdin-filename ${join(root, "pkg/main.py")} -\n`);
});

it("prefers the project's own install to the login shell's, found from the nearest folder that declares the formatter", async () => {
  await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { prettier: "3.0.0" } }));
  await script(join(root, "node_modules/.bin/prettier"), "sed 's/^/project: /'");
  await script(join(bin, "prettier"), "sed 's/^/login: /'");
  expect(await format("web/src/app.ts", "a\n")).toEqual({ kind: "formatted", text: "project: a\n" });
  expect(await readFile(marker, "utf8")).toBe(`--stdin-filepath ${join(root, "web/src/app.ts")}\n`);
});

it("formats nothing a project doesn't declare, even with the formatter installed", async () => {
  await script(join(root, "node_modules/.bin/prettier"), UPPERCASE);
  await script(join(bin, "gofmt"), UPPERCASE);
  expect(await format("app.ts", "a\n")).toEqual({ kind: "unavailable" });
  expect(await format("main.go", "package main\n")).toEqual({ kind: "unavailable" });
  await expect(access(marker)).rejects.toThrow();
});

it("runs a formatter without ELECTRON_RUN_AS_NODE from the core's environment", async () => {
  await writeFile(join(root, "go.mod"), "module example.com/app\n");
  await script(join(bin, "gofmt"), `cat; echo "electron=\${ELECTRON_RUN_AS_NODE:-unset}"`);
  const result = await format("main.go", "package main\n", "checkout", formatter({ env: { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" } }));
  expect(result).toEqual({ kind: "formatted", text: "package main\nelectron=unset\n" });
});

it("reports a formatter that fails, stops one that hangs, and refuses an empty or oversized answer", async () => {
  await writeFile(join(root, "go.mod"), "module example.com/app\n");
  const cases: [string, string][] = [
    ["echo 'main.go:1:9: expected declaration' >&2; exit 2", "gofmt: main.go:1:9: expected declaration"],
    ["exec sleep 30", "gofmt: it took longer than 2 seconds and was stopped"],
    ["cat > /dev/null", "gofmt: it returned no text"],
    ["head -c 3000000 /dev/zero | tr '\\0' a", "gofmt: its output is larger than a file can be saved at (2 MB)"],
  ];
  for (const [body, message] of cases) {
    await script(join(bin, "gofmt"), body);
    const started = Date.now();
    expect(await format("main.go", "package main\n", "checkout", formatter({ timeoutMs: 2_000 }))).toEqual({ kind: "failed", message });
    expect(Date.now() - started).toBeLessThan(5_000);
  }
});

it("lets the bundled Prettier stand in only where asked, for the languages it knows", async () => {
  const bundled = new FileFormatter({ bundled: { format: async (text, filepath) => `${filepath}: ${text}` }, environment: login });
  expect(await bundled.format({ root, kind: "checkout" }, FolderPath.parse("src/app.ts"), "a", false)).toEqual({ kind: "unavailable" });
  expect(await bundled.format({ root, kind: "checkout" }, FolderPath.parse("src/app.ts"), "a", true)).toEqual({ kind: "formatted", text: "src/app.ts: a" });
  expect(await bundled.format({ root, kind: "checkout" }, FolderPath.parse("main.py"), "a", true)).toEqual({ kind: "unavailable" });
});
