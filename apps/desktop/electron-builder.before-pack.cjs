// Keep the hook entry inside the app directory on packagers that cannot detect
// the pnpm workspace root on Windows. The shared audit remains authoritative.
const verifyNotices = require("../../scripts/distribution-notices.cjs");
const { configureNativeFiles } = require("../../scripts/packaged-native-target.cjs");
const { packagedRuntimePatterns } = require("../../scripts/packaged-runtime-dependencies.cjs");

const fs = require("node:fs");
const path = require("node:path");

/** Cloud workspaces need the brain inside the app; a package without one would fail only when someone sets one up. */
function requireBrainBundle() {
  const dist = path.join(__dirname, "..", "brain", "dist");
  const names = fs.existsSync(dist) ? fs.readdirSync(dist) : [];
  for (const [what, pattern] of [
    ["brain archive", /^brain-.+\.tgz$/],
    ["door", /^door-[0-9a-f]{12}\.mjs$/],
  ]) {
    if (names.filter((name) => pattern.test(name)).length !== 1) throw new Error(`apps/brain/dist needs exactly one cloud ${what}: run pnpm --filter @openorc/brain bundle first.`);
  }
}

module.exports = (context) => {
  requireBrainBundle();
  verifyNotices();
  configureNativeFiles(context, packagedRuntimePatterns(__dirname));
};
