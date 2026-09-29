/**
 * Linux installers built on a contributor's machine (package:linux): AppImage, deb and rpm, like a release but with
 * no release repository. Without one there is no update metadata to write, and electron-builder fails trying.
 * Installed Linux builds do not update themselves; the release configuration builds the published installers.
 */
module.exports = {
  extends: "./electron-builder.yml",
  linux: { target: ["AppImage", "deb", "rpm"] },
  publish: null,
};
