// Builds the core the Windows app runs inside a WSL distribution: dist/wsl/wsl-core-<version>.tgz, which main installs
// into the distribution and starts under a Node it puts beside it. The code is one esbuild bundle per entry, as the
// cloud brain's is (apps/brain/build.mjs), and the native modules are the brain's own: both are this core, headless,
// on Linux x64 with glibc, so `pnpm deploy` of the brain yields exactly what this needs, with the workspace's patches,
// overrides and lockfile versions.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { build } from "esbuild";

const desktop = path.resolve(import.meta.dirname, "..");
const workspace = path.resolve(desktop, "..", "..");
const dist = path.join(desktop, "dist", "wsl");
const app = path.join(dist, "app");
const modules = path.join(app, "node_modules");
const brain = JSON.parse(readFileSync(path.join(workspace, "apps", "brain", "package.json"), "utf8"));
/** Loaded at runtime with their native binaries, so they stay out of the bundle. */
const natives = Object.keys(brain.dependencies);
/** Required inside a try by ws, which works without them; nothing else may be left for runtime unshipped. */
const optional = ["bufferutil", "utf-8-validate"];
const runner = path.join(workspace, "packages", "cloud", "src", "runner");
const TARGET = { os: "linux", cpu: "x64", libc: "glibc" };
const fail = (message) => {
  console.error(`wsl core build: ${message}`);
  process.exit(1);
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

const { metafile } = await build({
  absWorkingDir: desktop,
  entryPoints: {
    core: "src/core/wsl/main.ts",
    // The core starts these as worker threads by file name.
    "embedder-worker": "src/core/embedder-worker.ts",
    "formatter-worker": "src/core/formatter-worker.ts",
    "intelligence-worker": "src/core/intelligence-worker.ts",
  },
  outdir: app,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  mainFields: ["module", "main"],
  external: natives,
  // A release build: the test switches of a development build are compiled out, as in the packaged app.
  define: { __OPENORC_QA__: "false" },
  // Bundled CommonJS packages require Node's own modules, and an ES module has no require of its own.
  banner: { js: 'import { createRequire as __coreRequire } from "node:module"; const require = __coreRequire(import.meta.url);' },
  metafile: true,
  logLevel: "warning",
});

const packageName = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
const unshipped = new Set(
  Object.values(metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((entry) => entry.external && !entry.path.startsWith("node:") && !builtinModules.includes(entry.path))
    .map((entry) => packageName(entry.path))
    .filter((name) => !natives.includes(name) && !optional.includes(name)),
);
if (unshipped.size) fail(`the bundle loads ${[...unshipped].join(", ")} at runtime, which the cloud brain's dependencies do not ship`);

mkdirSync(path.join(app, "runner"));
for (const name of readdirSync(runner).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))) writeFileSync(path.join(app, "runner", name), readFileSync(path.join(runner, name)));

const deployed = path.join(dist, "deploy");
const target = Object.entries(TARGET).flatMap(([key, value]) => [`--${key}`, value]);
execFileSync("pnpm", ["--filter", brain.name, "--config.inject-workspace-packages=true", "deploy", "--prod", ...target, deployed], {
  cwd: workspace,
  stdio: ["ignore", "ignore", "inherit"],
  shell: process.platform === "win32",
});
renameSync(path.join(deployed, "node_modules"), modules);
rmSync(deployed, { recursive: true, force: true });
// pnpm's own records of the install: not needed to load anything, and they carry the time of the install.
for (const record of [".modules.yaml", ".package-map.json", ".pnpm-workspace-state-v1.json", ".pnpm/lock.yaml"]) rmSync(path.join(modules, record), { force: true });

// onnxruntime ships every platform's binaries; a distribution runs only one.
const onnx = path.join(modules, "onnxruntime-node", "bin");
for (const napi of readdirSync(onnx)) {
  for (const platform of readdirSync(path.join(onnx, napi))) {
    const folder = path.join(onnx, napi, platform);
    if (platform !== TARGET.os) rmSync(folder, { recursive: true });
    else for (const cpu of readdirSync(folder)) if (cpu !== TARGET.cpu) rmSync(path.join(folder, cpu), { recursive: true });
  }
}

const required = {
  "sqlite-vec's Linux x64 extension": path.join(realpathSync(path.join(modules, "sqlite-vec")), "..", "sqlite-vec-linux-x64", "vec0.so"),
  "onnxruntime's Linux x64 binding": path.join(onnx, "napi-v3", "linux", "x64", "onnxruntime_binding.node"),
  "onnxruntime's Linux x64 library": path.join(onnx, "napi-v3", "linux", "x64", "libonnxruntime.so.1"),
  "the workspace's fastembed patch": path.join(modules, "fastembed", "lib", "minilm-tokenizer.cjs"),
};
for (const [what, file] of Object.entries(required)) if (!existsSync(file)) fail(`${what} is missing (${path.relative(app, file)})`);

/** Every path under `dir` with what it holds, in a fixed order, so the same tree always hashes the same. */
function digest(dir, hash = createHash("sha256"), prefix = "") {
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const relative = `${prefix}${name}`;
    const stats = lstatSync(file);
    hash.update(`${relative}\0${stats.mode & 0o111 ? "x" : "-"}\0`);
    if (stats.isSymbolicLink()) hash.update(`-> ${readlinkSync(file)}\0`);
    else if (stats.isDirectory()) digest(file, hash, `${relative}/`);
    else hash.update(readFileSync(file));
  }
  return hash;
}
// Named by what it holds alone, so the app installs a core into a distribution once and finds it there afterwards.
const version = digest(app).digest("hex").slice(0, 16);
writeFileSync(path.join(app, "manifest.json"), `${JSON.stringify({ version, node: 24, platform: `${TARGET.os}-${TARGET.cpu}-${TARGET.libc}` }, null, 2)}\n`);

const archive = path.join(dist, `wsl-core-${version}.tgz`);
execFileSync("tar", ["--no-xattrs", "-czf", archive, "-C", app, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
// Only the archive stays. This folder is inside the desktop app's own, where packaging the app would take the
// unpacked core's node_modules for the app's and put them in its archive.
rmSync(app, { recursive: true, force: true });
console.log(`${path.relative(process.cwd(), archive)} (${(lstatSync(archive).size / 1024 / 1024).toFixed(1)} MB)`);
