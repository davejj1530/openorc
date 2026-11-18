// Keep the hook entry inside the app directory on packagers that cannot detect
// the pnpm workspace root on Windows. The shared audit remains authoritative.
const verifyNotices = require("../../scripts/distribution-notices.cjs");
const { configureNativeFiles } = require("../../scripts/packaged-native-target.cjs");
const { packagedRuntimePatterns } = require("../../scripts/packaged-runtime-dependencies.cjs");

const fs = require("node:fs");
const path = require("node:path");

/** Running inside a WSL distribution needs the core for it inside the app; a Windows package without one would fail only when someone chooses a distribution. */
function requireWslCore(context) {
  if (context.electronPlatformName !== "win32") return;
  const dist = path.join(__dirname, "dist", "wsl");
  const names = fs.existsSync(dist) ? fs.readdirSync(dist) : [];
  if (names.filter((name) => /^wsl-core-.+\.tgz$/.test(name)).length !== 1)
    throw new Error("apps/desktop/dist/wsl needs exactly one core for WSL: run pnpm --filter @openorc/desktop bundle:wsl on Linux or inside WSL, and copy its archive there.");
}

module.exports = (context) => {
  requireWslCore(context);
  verifyNotices();
  configureNativeFiles(context, packagedRuntimePatterns(__dirname));
};
