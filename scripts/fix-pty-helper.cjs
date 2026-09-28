/**
 * node-pty ships a `spawn-helper` beside its prebuilt binding and exec's it by
 * path. The tarball carries the executable bit, but pnpm's store extraction
 * drops it, and the only symptom is `posix_spawnp failed` at the first spawn:
 * no missing file, no load error, nothing that names the helper.
 *
 * Runs from the desktop package's postinstall so a fresh clone works. A no-op
 * on Windows, which uses conpty and has no helper.
 */
const { chmodSync, existsSync, statSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");

if (process.platform === "win32") process.exit(0);
let root;
try {
  root = dirname(createRequire(join(process.cwd(), "package.json")).resolve("node-pty/package.json"));
} catch {
  // Not installed yet, or installed without its optional platform build. The
  // terminal reports its own failure; an install must not break over it.
  process.exit(0);
}
let fixed = 0;
for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]) {
  const helper = join(root, "prebuilds", platform, "spawn-helper");
  if (!existsSync(helper)) continue;
  if (statSync(helper).mode & 0o111) continue;
  chmodSync(helper, 0o755);
  fixed += 1;
}
if (fixed > 0) console.log(`[openorc] made ${fixed} node-pty spawn-helper binaries executable`);
