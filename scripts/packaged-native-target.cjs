const assert = require("node:assert/strict");

const originalFiles = new WeakMap();

/** Add exclusions to the existing normalized file sets, without widening the app's include list. */
function configureNativeFiles({ packager, electronPlatformName: platform }, runtimePatterns = []) {
  const config = packager.config;
  if (!originalFiles.has(config)) originalFiles.set(config, structuredClone(config.files));
  const files = originalFiles.get(config);
  if (!["darwin", "win32"].includes(platform)) {
    config.files = structuredClone(files);
    return;
  }
  // Keep the arch macro for electron-builder to expand for each pack operation,
  // including concurrent arm64/x64 builds. Platforms themselves build sequentially.
  const target = `${platform}-\${arch}`;
  const sqlite = platform === "win32" ? "windows-${arch}" : target;
  const exclusions = [
    `!**/node_modules/onnxruntime-node/bin/napi-v*/!(${platform}){,/**}`,
    `!**/node_modules/onnxruntime-node/bin/napi-v*/${platform}/!(\${arch}){,/**}`,
    `!**/node_modules/node-pty/prebuilds/!(${target}){,/**}`,
    // Keep package metadata and license notices even for unused sqlite targets.
    `!**/node_modules/sqlite-vec-!(${sqlite})/**/*.{dylib,so,dll}`,
  ];
  // Separate platform.files patterns create an extra include-all matcher in
  // electron-builder 26. Append to the common file sets instead. Start from the
  // original list on every call so another platform cannot inherit these rules.
  config.files = files.map((fileSet) => ({
    ...fileSet,
    // Reapply the shared exclusions after runtime inclusions so maps, demos,
    // and unused Node WebGPU bindings cannot be brought back by a parent package.
    filter: [...fileSet.filter, ...runtimePatterns, ...fileSet.filter.filter((pattern) => pattern.startsWith("!")), ...exclusions],
  }));
}

/** Read the target encoded by the native dependencies' published directory/file layouts. */
function nativeTarget(file) {
  const onnx = /\/onnxruntime-node\/bin\/napi-v\d+\/([^/]+)\/([^/]+)\//.exec(file);
  if (onnx) return `${onnx[1]}-${onnx[2]}`;
  const pty = /\/node-pty\/prebuilds\/([^/]+)\//.exec(file);
  if (pty) return pty[1];
  const sqlite = /\/sqlite-vec-([^/]+)\/.*\.(?:dylib|so|dll)$/.exec(file);
  return sqlite?.[1].replace(/^windows-/, "win32-") ?? null;
}

/** Check the shipped inventory, independently of electron-builder's file filters. */
function verifyNativeTarget(entries, platform, arch) {
  const target = `${platform}-${arch}`;
  assert.ok(["darwin-arm64", "darwin-x64", "win32-x64"].includes(target), `Unsupported native package target: ${target}`);
  const files = entries.map((file) => file.replaceAll("\\", "/").replace(/^\/+/, ""));
  assert.deepEqual(
    files.filter((file) => /(?:^|\/)node_modules\/webgpu\/dist\/[^/]+\.dawn\.node$/.test(file)),
    [],
    "Unused Node WebGPU bindings must stay outside the distributed app; graphics use Electron's browser WebGPU",
  );
  const foreign = files.filter((file) => {
    const native = nativeTarget(`/${file}`);
    return native && native !== target;
  });
  assert.deepEqual(foreign, [], `Native dependency files for another target in ${target}`);

  const onnx = `node_modules/onnxruntime-node/bin/napi-v3/${platform}/${arch}/`;
  const pty = `node_modules/node-pty/prebuilds/${target}/`;
  const sqlitePlatform = platform === "win32" ? "windows" : platform;
  const required = [`${onnx}onnxruntime_binding.node`, `${pty}pty.node`, `node_modules/sqlite-vec-${sqlitePlatform}-${arch}/vec0.${platform === "darwin" ? "dylib" : "dll"}`];
  if (platform === "darwin") {
    required.push(`${pty}spawn-helper`);
    assert.ok(
      files.some((file) => file.startsWith(onnx) && /\/libonnxruntime[^/]*\.dylib$/.test(file)),
      "Missing macOS ONNX Runtime library",
    );
  } else {
    required.push(`${onnx}onnxruntime.dll`, `${onnx}DirectML.dll`);
    for (const file of ["conpty.node", "conpty_console_list.node", "winpty.dll", "winpty-agent.exe", "conpty/conpty.dll", "conpty/OpenConsole.exe"]) required.push(`${pty}${file}`);
  }
  for (const file of required) assert.ok(files.includes(file), `Missing required native dependency: ${file}`);
}

module.exports = { configureNativeFiles, verifyNativeTarget };
