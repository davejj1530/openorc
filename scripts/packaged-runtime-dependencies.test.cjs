const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { dependencyGraph, runtimeDependencies, runtimeFilePatterns, verifyCompiledImports } = require("./packaged-runtime-dependencies.cjs");
const { configureNativeFiles } = require("./packaged-native-target.cjs");

const desktop = createRequire(path.resolve(__dirname, "../apps/desktop/package.json"));
const builder = createRequire(desktop.resolve("electron-builder"));
const library = createRequire(builder.resolve("app-builder-lib"));
const { FileMatcher, getNodeModuleFileMatcher } = builder("app-builder-lib/out/fileMatcher");
const { NodeModuleCopyHelper } = builder("app-builder-lib/out/util/NodeModuleCopyHelper");
const { doMergeConfigs } = builder("app-builder-lib/out/util/config/config");
const baseConfig = library("js-yaml").load(fs.readFileSync(path.resolve(__dirname, "../apps/desktop/electron-builder.yml"), "utf8"));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openorc-runtime-deps-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, content = "fixture") => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  return { root, write };
}

test("runtime closure follows production, optional, peer, nested-version and cycle edges", (t) => {
  const { root, write } = fixture(t);
  const pkg = (directory, name, extra = {}) => write(`${directory}/package.json`, JSON.stringify({ name, ...extra }));
  pkg(".", "app", { dependencies: { runtime: "1", bundled: "1" }, devDependencies: { development: "1" } });
  pkg("node_modules/runtime", "runtime", { dependencies: { shared: "1" }, optionalDependencies: { platform: "1" }, peerDependencies: { peer: "1" } });
  pkg("node_modules/shared", "shared", { dependencies: { runtime: "1" } });
  pkg("node_modules/peer", "peer");
  pkg("node_modules/bundled", "bundled", { dependencies: { shared: "2" } });
  pkg("node_modules/bundled/node_modules/shared", "shared", { dependencies: { extra: "1" } });
  pkg("node_modules/bundled/node_modules/extra", "extra");
  pkg("node_modules/development", "development");
  const graph = dependencyGraph(root);
  assert.deepEqual([...runtimeDependencies(graph, ["runtime"])].sort(), ["peer", "platform", "runtime", "shared"]);
  assert.ok(![...graph.values()].some((node) => node.name === "development"));
  assert.ok(runtimeDependencies(graph, ["shared"]).has("extra"), "All installed versions of an explicit root are kept");
  assert.throws(() => runtimeDependencies(graph, ["missing"]), /not in the production graph/);
  fs.rmSync(path.join(root, "node_modules/shared"), { recursive: true });
  assert.throws(() => dependencyGraph(root), /Missing production dependency shared/);
});

for (const target of ["darwin-arm64", "darwin-x64", "win32-x64"]) {
  test(`copying retains runtime files and notices but omits bundled library copies for ${target}`, async (t) => {
    const { root, write } = fixture(t);
    const [platform, arch] = target.split("-");
    const config = doMergeConfigs([structuredClone(baseConfig)]);
    const packager = { config, appInfo: { type: "commonjs" }, debugLogger: { isEnabled: false }, getWorkspaceRoot: async () => root };
    configureNativeFiles({ packager, electronPlatformName: platform }, runtimeFilePatterns(new Set(["runtime", "@scope/runtime", "node-pty"])));
    const matcher = getNodeModuleFileMatcher(root, path.join(root, "app"), (pattern) => pattern.replaceAll("${arch}", arch), config[platform === "darwin" ? "mac" : "win"], packager);
    const files = [
      "package.json",
      "LICENSE",
      "dist/THIRD_PARTY_NOTICES.txt",
      "legal/licenses/upstream.txt",
      "dist/index.js",
      "dist/index.js.map",
      "dist/data.json",
      "dist/worker.mjs",
      "font.woff2",
      "runtime.wasm",
    ];
    for (const name of ["runtime", "@scope/runtime", "bundled", "@scope/bundled", "node-pty"]) {
      const source = path.join(root, "installed", name);
      for (const file of files) write(`installed/${name}/${file}`);
      for (const prefix of ["node_modules/", "node_modules/bundled/node_modules/"]) {
        const destination = `${prefix}${name}`;
        const copyMatcher = new FileMatcher(source, path.join(root, "app", destination), matcher.macroExpander, matcher.patterns);
        const copier = new NodeModuleCopyHelper(copyMatcher, packager);
        const copied = await copier.collectNodeModules({ dir: source, name }, [], destination);
        const actual = copied.filter((file) => !copier.metadata.get(file)?.isDirectory()).map((file) => path.relative(source, file).replaceAll("\\", "/"));
        const expected = files.filter((file) => !file.endsWith(".map") && (!name.endsWith("bundled") || files.slice(0, 4).includes(file)));
        assert.deepEqual(actual.sort(), expected.sort(), destination);
      }
      for (const file of files) assert.equal(fs.readFileSync(path.join(source, file), "utf8"), "fixture");
    }
  });
}

test("compiled import audit accepts covered imports and rejects newly uncovered or nonliteral loads", (t) => {
  const { root, write } = fixture(t);
  write("out/main/index.mjs", 'import fs from "node:fs"; import "electron"; import "runtime/subpath"; import("@scope/runtime");');
  write("out/preload/index.js", 'require("electron"); require("runtime");');
  write("out/renderer/assets/view.js", 'import "./chunk.js"; import("./lazy.js");');
  const names = new Set(["runtime", "@scope/runtime"]);
  assert.deepEqual([...verifyCompiledImports(root, names)].sort(), ["@scope/runtime", "runtime"]);
  write("out/main/index.mjs", 'import("not-kept");');
  assert.throws(() => verifyCompiledImports(root, names), /Uncovered compiled import not-kept/);
  write("out/main/index.mjs", "require(variable);");
  assert.throws(() => verifyCompiledImports(root, names), /Nonliteral compiled module load/);
  write("out/main/index.mjs", "");
  write("out/renderer/assets/view.js", 'import "runtime";');
  assert.throws(() => verifyCompiledImports(root, names), /Uncovered compiled import runtime/);
});
