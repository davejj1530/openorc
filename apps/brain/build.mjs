// Builds the cloud brain for a Linux x64 (glibc) sandbox: dist/brain-<version>.tgz, which BrainMachine.provision
// installs. The code is one esbuild bundle per entry; the native modules come from `pnpm deploy` of this app, so they
// carry the workspace's patches, overrides and lockfile versions, as the desktop's do.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { build } from "esbuild";

const here = import.meta.dirname;
const workspace = path.resolve(here, "..", "..");
const dist = path.join(here, "dist");
const app = path.join(dist, "app");
const modules = path.join(app, "node_modules");
const manifest = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8"));
/** Loaded at runtime with their native binaries, so they stay out of the bundle; they are this app's only dependencies. */
const natives = Object.keys(manifest.dependencies);
/** Required inside a try by ws, which works without them; nothing else may be left for runtime unshipped. */
const optional = ["bufferutil", "utf-8-validate"];
const runner = path.join(workspace, "packages", "cloud", "src", "runner");
const TARGET = { os: "linux", cpu: "x64", libc: "glibc" };
const fail = (message) => {
  console.error(`brain build: ${message}`);
  process.exit(1);
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

const { metafile } = await build({
  absWorkingDir: here,
  entryPoints: { brain: "src/main.ts", ctl: "src/ctl.ts", "embedder-worker": "src/embedder-worker.ts" },
  outdir: app,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  mainFields: ["module", "main"],
  external: natives,
  // Bundled CommonJS packages require Node's own modules, and an ES module has no require of its own.
  banner: { js: 'import { createRequire as __brainRequire } from "node:module"; const require = __brainRequire(import.meta.url);' },
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
if (unshipped.size) fail(`the bundle loads ${[...unshipped].join(", ")} at runtime, which no dependency ships`);

mkdirSync(path.join(app, "runner"));
for (const name of readdirSync(runner).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))) writeFileSync(path.join(app, "runner", name), readFileSync(path.join(runner, name)));

const deployed = path.join(dist, "deploy");
const target = Object.entries(TARGET).flatMap(([key, value]) => [`--${key}`, value]);
execFileSync("pnpm", ["--filter", manifest.name, "--config.inject-workspace-packages=true", "deploy", "--prod", ...target, deployed], { cwd: workspace, stdio: ["ignore", "ignore", "inherit"] });
renameSync(path.join(deployed, "node_modules"), modules);
rmSync(deployed, { recursive: true, force: true });
// pnpm's own records of the install: not needed to load anything, and they carry the time of the install.
for (const record of [".modules.yaml", ".package-map.json", ".pnpm-workspace-state-v1.json", ".pnpm/lock.yaml"]) rmSync(path.join(modules, record), { force: true });

// onnxruntime ships every platform's binaries; the brain runs only one.
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
const version = digest(app).digest("hex").slice(0, 12);
writeFileSync(path.join(app, "manifest.json"), `${JSON.stringify({ version, node: 24, platform: `${TARGET.os}-${TARGET.cpu}-${TARGET.libc}` }, null, 2)}\n`);

const archive = path.join(dist, `brain-${version}.tgz`);
execFileSync("tar", ["--no-xattrs", "-czf", archive, "-C", app, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
console.log(`${path.relative(process.cwd(), archive)} (${(lstatSync(archive).size / 1024 / 1024).toFixed(1)} MB)`);
