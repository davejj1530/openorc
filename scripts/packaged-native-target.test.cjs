const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { configureNativeFiles, verifyNativeTarget } = require("./packaged-native-target.cjs");

const desktop = createRequire(path.resolve(__dirname, "../apps/desktop/package.json"));
const builder = createRequire(desktop.resolve("electron-builder"));
const library = createRequire(builder.resolve("app-builder-lib"));
const { FileMatcher, getMainFileMatchers, getNodeModuleFileMatcher } = builder("app-builder-lib/out/fileMatcher");
const { doMergeConfigs } = builder("app-builder-lib/out/util/config/config");
const { NodeModuleCopyHelper } = builder("app-builder-lib/out/util/NodeModuleCopyHelper");
const baseConfig = library("js-yaml").load(fs.readFileSync(path.resolve(__dirname, "../apps/desktop/electron-builder.yml"), "utf8"));
const targets = ["darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64", "linux-x64", "linux-arm64", "linux-riscv64"];
const builderPlatform = { darwin: "mac", win32: "win", linux: "linux" };

/**
 * What an install on `host` holds. Files for other targets must be filtered out; `dropped` files are the host's own
 * but must not ship either.
 */
function nativeFixture(host = "darwin-arm64") {
  const files = [];
  const add = (pkg, file, target = null, dropped = false) => files.push({ pkg, file, target, dropped });
  for (const target of targets) {
    const [platform, arch] = target.split("-");
    const onnx = `bin/napi-v3/${platform}/${arch}/`;
    add("onnxruntime-node", `${onnx}onnxruntime_binding.node`, target);
    if (platform === "darwin") add("onnxruntime-node", `${onnx}libonnxruntime.1.21.0.dylib`, target);
    else if (platform === "win32") for (const name of ["onnxruntime.dll", "DirectML.dll"]) add("onnxruntime-node", onnx + name, target);
    else {
      for (const name of ["libonnxruntime.so.1", "libonnxruntime_providers_shared.so"]) add("onnxruntime-node", onnx + name, target);
      // The package's spare copy of libonnxruntime.so.1, which the binding never loads.
      add("onnxruntime-node", `${onnx}libonnxruntime.so.1.21.0`, target, true);
    }
    // node-pty publishes prebuilds for macOS and Windows only.
    if (platform !== "linux") {
      add("node-pty", `prebuilds/${target}/pty.node`, target);
      const helpers = platform === "win32" ? ["conpty.node", "conpty_console_list.node", "winpty.dll", "winpty-agent.exe", "conpty/conpty.dll", "conpty/OpenConsole.exe"] : ["spawn-helper"];
      for (const name of helpers) add("node-pty", `prebuilds/${target}/${name}`, target);
    }
    if (platform !== "darwin") add("webgpu", `dist/${target}.dawn.node`, target);
    const sqlitePlatform = platform === "win32" ? "windows" : platform;
    let extension = "so";
    if (platform === "darwin") extension = "dylib";
    else if (platform === "win32") extension = "dll";
    add(`sqlite-vec-${sqlitePlatform}-${arch}`, `vec0.${extension}`, target);
  }
  if (host.startsWith("linux-")) {
    // Installing node-pty on Linux compiles its binding; the build leaves its makefiles behind.
    add("node-pty", "build/Release/pty.node", host);
    for (const file of ["build/Makefile", "build/binding.Makefile", "build/config.gypi", "build/pty.target.mk", "build/Release/obj.target/pty/src/unix/pty.o"]) add("node-pty", file, host, true);
    // onnxruntime-node's install script adds GPU providers on Linux x64.
    for (const name of ["libonnxruntime_providers_cuda.so", "libonnxruntime_providers_tensorrt.so"]) add("onnxruntime-node", `bin/napi-v3/linux/x64/${name}`, "linux-x64", true);
  }
  add("webgpu", "dist/darwin-universal.dawn.node", "darwin-universal");
  add("onnxruntime-node", "dist/binding.js");
  add("onnxruntime-node", "dist/binding.js.map");
  add("webgpu", "dist/index.js");
  add("webgpu", "dist/index.js.map");
  add("node-pty", "lib/index.js");
  add("node-pty", "lib/index.js.map");
  add("renderer-library", "dist/index.mjs");
  add("renderer-library", "dist/index.mjs.map");
  add("renderer-library", "dist/theme.css");
  add("renderer-library", "dist/theme.css.map");
  add("renderer-library", "demo/demo.html");
  add("cytoscape-fcose", "cytoscape-fcose.js");
  for (const file of [
    "demo.gif",
    "incrementalConstraints.gif",
    "demo.html",
    "demo-compound.html",
    "demo-constraint.html",
    "demo-constraint-control.js",
    "samples/callGraph.js",
    "samples/callGraph_constraints.js",
  ]) {
    add("cytoscape-fcose", `demo/${file}`);
  }
  for (const pkg of new Set(files.map((file) => file.pkg))) {
    add(pkg, "package.json");
    add(pkg, "LICENSE");
  }
  return files;
}

for (const target of ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]) {
  test(`electron-builder copies only compatible native files for ${target}, including nested dependencies`, async (t) => {
    const [platform, arch] = target.split("-");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openorc-native-filter-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = nativeFixture(target);
    const packageRoot = (pkg) => path.join(root, ".pnpm", `${pkg}@fixture`, "node_modules", pkg);
    for (const { pkg, file } of fixture) {
      const source = path.join(packageRoot(pkg), file);
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, "fixture");
    }
    const config = doMergeConfigs([structuredClone(baseConfig)]);
    const packager = { config, projectDir: root, buildResourcesDir: "build", appInfo: { type: "commonjs" }, debugLogger: { isEnabled: false }, getWorkspaceRoot: async () => root };
    configureNativeFiles({ packager, electronPlatformName: platform });
    const matcher = getNodeModuleFileMatcher(root, path.join(root, "app"), (pattern) => pattern.replaceAll("${arch}", arch), config[builderPlatform[platform]], packager);
    const mainMatchers = getMainFileMatchers(root, path.join(root, "app"), matcher.macroExpander, config[builderPlatform[platform]], { info: packager }, path.join(root, "release"), false);
    assert.equal(mainMatchers.length, 1, "Platform exclusions must not introduce an include-all file set");
    const mainFilter = mainMatchers[0].createFilter();
    for (const file of ["out/main/index.mjs", "out/preload/index.js", "out/renderer/index.html", "out/renderer/assets/theme.css", "out/renderer/assets/rive.wasm", "resources/icon.png"]) {
      assert.equal(mainFilter(path.join(root, file), { isDirectory: () => false }), true, file);
    }
    for (const file of [
      "src/main/index.ts",
      "src/main/index.test.ts",
      "out/types-web/tsconfig.web.tsbuildinfo",
      "electron.vite.config.ts",
      "AGENTS.md",
      "out/main/index.mjs.map",
      "out/preload/index.js.map",
      "out/renderer/assets/theme.css.map",
      `node_modules/node-pty/prebuilds/${target}/pty.node.map`,
    ]) {
      assert.equal(mainFilter(path.join(root, file), { isDirectory: () => false }), false, file);
    }
    for (const prefix of ["node_modules/", "node_modules/parent/node_modules/"]) {
      const copied = [];
      for (const pkg of new Set(fixture.map((file) => file.pkg))) {
        const source = packageRoot(pkg);
        const destination = `${prefix}${pkg}`;
        const copyMatcher = new FileMatcher(source, path.join(root, "app", destination), matcher.macroExpander, matcher.patterns);
        const copier = new NodeModuleCopyHelper(copyMatcher, packager);
        const files = await copier.collectNodeModules({ dir: source, name: pkg }, [], destination);
        copied.push(...files.filter((file) => !copier.metadata.get(file)?.isDirectory()).map((file) => `${destination}/${path.relative(source, file).replaceAll("\\", "/")}`));
      }
      const expected = fixture
        .filter((file) => !file.target || file.target === target)
        .filter((file) => !file.dropped)
        .filter((file) => file.pkg !== "webgpu" || !file.file.endsWith(".dawn.node"))
        .filter((file) => !file.file.endsWith(".map"))
        .filter((file) => file.pkg !== "cytoscape-fcose" || !file.file.startsWith("demo/"))
        .map((file) => `${prefix}${file.pkg}/${file.file}`);
      assert.deepEqual(copied.sort(), expected.sort());
      if (prefix === "node_modules/") verifyNativeTarget(copied, platform, arch);
    }
    for (const { pkg, file } of fixture) assert.equal(fs.readFileSync(path.join(packageRoot(pkg), file), "utf8"), "fixture", "Filtering must not modify installed dependencies");
  });
}

test("reusing a build configuration does not accumulate another platform's exclusions", () => {
  const config = doMergeConfigs([structuredClone(baseConfig)]);
  const original = structuredClone(config.files);
  for (const platform of ["darwin", "win32", "linux", "darwin"]) {
    configureNativeFiles({ packager: { config }, electronPlatformName: platform });
    const fresh = doMergeConfigs([structuredClone(baseConfig)]);
    configureNativeFiles({ packager: { config: fresh }, electronPlatformName: platform });
    assert.deepEqual(config.files, fresh.files);
  }
  configureNativeFiles({ packager: { config }, electronPlatformName: "freebsd" });
  assert.deepEqual(config.files, original);
});

test("shipped inventory rejects foreign files and missing runtime libraries/helpers", () => {
  const fixture = nativeFixture();
  const files = fixture.filter((file) => !file.target || (file.target === "darwin-arm64" && file.pkg !== "webgpu")).map((file) => `node_modules/${file.pkg}/${file.file}`);
  assert.doesNotThrow(() => verifyNativeTarget(files, "darwin", "arm64"));
  for (const { pkg, file, target } of fixture) {
    if (!target || target === "darwin-arm64" || pkg === "webgpu") continue;
    assert.throws(() => verifyNativeTarget([...files, `node_modules/parent/node_modules/${pkg}/${file}`], "darwin", "arm64"), /another target/);
  }
  for (const { pkg, file } of fixture.filter((file) => file.pkg === "webgpu" && file.target)) {
    for (const prefix of ["node_modules/", "node_modules/parent/node_modules/"]) {
      assert.throws(() => verifyNativeTarget([...files, `${prefix}${pkg}/${file}`], "darwin", "arm64"), /Unused Node WebGPU bindings/);
    }
  }
  for (const suffix of ["spawn-helper", "pty.node", "onnxruntime_binding.node", "libonnxruntime.1.21.0.dylib", "vec0.dylib"]) {
    assert.throws(
      () =>
        verifyNativeTarget(
          files.filter((file) => !file.endsWith(suffix)),
          "darwin",
          "arm64",
        ),
      /Missing/,
    );
  }
  assert.throws(() => verifyNativeTarget(files, "linux", "arm64"), /Unsupported/);
  assert.doesNotThrow(() =>
    verifyNativeTarget(
      files.map((file) => `\\${file.replaceAll("/", "\\")}`),
      "darwin",
      "arm64",
    ),
  );
});

test("a Linux inventory needs node-pty's compiled binding and leaves out GPU providers", () => {
  const fixture = nativeFixture("linux-x64");
  const files = fixture.filter((file) => !file.dropped && (!file.target || (file.target === "linux-x64" && file.pkg !== "webgpu"))).map((file) => `node_modules/${file.pkg}/${file.file}`);
  assert.doesNotThrow(() => verifyNativeTarget(files, "linux", "x64"));
  for (const suffix of ["build/Release/pty.node", "onnxruntime_binding.node", "libonnxruntime.so.1", "vec0.so"]) {
    assert.throws(
      () =>
        verifyNativeTarget(
          files.filter((file) => !file.endsWith(suffix)),
          "linux",
          "x64",
        ),
      /Missing/,
    );
  }
  for (const name of ["libonnxruntime_providers_cuda.so", "libonnxruntime_providers_tensorrt.so"]) {
    assert.throws(() => verifyNativeTarget([...files, `node_modules/onnxruntime-node/bin/napi-v3/linux/x64/${name}`], "linux", "x64"), /GPU ONNX Runtime providers/);
  }
  assert.throws(() => verifyNativeTarget([...files, "node_modules/node-pty/prebuilds/darwin-arm64/pty.node"], "linux", "x64"), /another target/);
});
