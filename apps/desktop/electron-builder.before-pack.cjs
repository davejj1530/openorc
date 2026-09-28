// Keep the hook entry inside the app directory on packagers that cannot detect
// the pnpm workspace root on Windows. The shared audit remains authoritative.
const verifyNotices = require("../../scripts/distribution-notices.cjs");
const { configureNativeFiles } = require("../../scripts/packaged-native-target.cjs");
const { packagedRuntimePatterns } = require("../../scripts/packaged-runtime-dependencies.cjs");

module.exports = (context) => {
  verifyNotices();
  configureNativeFiles(context, packagedRuntimePatterns(__dirname));
};
