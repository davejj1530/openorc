import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const website = resolve(desktop, "../website");
// The website already owns the workspace's image-processing dependency.
const sharp = createRequire(join(website, "package.json"))("sharp");
const source = readFileSync(join(desktop, "resources/icon.svg"), "utf8");
const master = await sharp(Buffer.from(source)).png().toBuffer();
writeFileSync(join(desktop, "resources/icon.png"), master);

// Browser tabs need the tile without the outer Dock padding.
const favicon = source.replace('viewBox="0 0 1024 1024"', 'viewBox="80 80 864 864"');
writeFileSync(join(website, "public/favicon.svg"), favicon);
writeFileSync(join(desktop, "src/renderer/src/assets/favicon.svg"), favicon);
await sharp(master).extract({ left: 80, top: 80, width: 864, height: 864 }).resize(64, 64, { kernel: "lanczos3" }).png().toFile(join(website, "public/favicon-64.png"));
console.log("Built resources/icon.png and the desktop/website favicons from resources/icon.svg");

if (process.platform !== "darwin") {
  console.log("Run icons:build on macOS to also refresh build/icon.icns");
  process.exit(0);
}

const temporary = mkdtempSync(join(tmpdir(), "openorc-icon-"));
const iconset = join(temporary, "icon.iconset");
try {
  mkdirSync(iconset);
  mkdirSync(join(desktop, "build"), { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = size * scale;
      const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
      await sharp(master).resize(pixels, pixels, { kernel: "lanczos3" }).png().toFile(join(iconset, name));
    }
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(desktop, "build/icon.icns")], { stdio: "inherit" });
  console.log("Built build/icon.icns from resources/icon.png");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
