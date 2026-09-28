/**
 * The package scripts/packaged-runtime-smoke.cjs runs. It reads the app's main process through Node's inspector,
 * which every other package switches off with a fuse, so this one differs from a local package in that fuse alone.
 * Never distribute it.
 */
module.exports = {
  extends: "./electron-builder.yml",
  directories: { output: "release-smoke" },
  electronFuses: { enableNodeCliInspectArguments: true },
};
