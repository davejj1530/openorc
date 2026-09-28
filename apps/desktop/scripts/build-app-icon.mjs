import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run on macOS after replacing resources/icon.png with a 1024px RGBA master.
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "openorc-icon-"));
const iconset = join(temporary, "icon.iconset");
try {
  mkdirSync(iconset);
  mkdirSync(join(desktop, "build"), { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
      execFileSync("sips", ["-z", pixels, pixels, join(desktop, "resources/icon.png"), "--out", join(iconset, name)], { stdio: "pipe" });
    }
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(desktop, "build/icon.icns")], { stdio: "inherit" });
  console.log("Built build/icon.icns from resources/icon.png");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
