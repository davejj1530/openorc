import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, expect, it } from "vitest";

/**
 * A terminal laid out by Chromium itself: a panel's host as the app draws it (border-box sizing, padding on three sides,
 * the app's own text letter-spacing), a full line written into it, and where its last character lands.
 */
const page = `
import { openXterm } from ${JSON.stringify(path.join(import.meta.dirname, "xterm.ts"))};

const host = document.getElementById("host");
const { term } = openXterm(host);
const line = "x".repeat(term.cols - 1) + "Z";
window.result = new Promise((resolve) => {
  term.write(line + "\\r\\ny".repeat(term.rows - 1), () => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const box = host.getBoundingClientRect();
      const style = getComputedStyle(host);
      const inner = { right: box.right - parseFloat(style.paddingRight), bottom: box.bottom - parseFloat(style.paddingBottom) };
      const rows = host.querySelectorAll(".xterm-rows > div");
      const first = rows[0];
      const text = [...first.querySelectorAll("span")].at(-1)?.firstChild ?? first.firstChild;
      const range = document.createRange();
      range.setStart(text, text.textContent.length - 1);
      range.setEnd(text, text.textContent.length);
      const last = range.getBoundingClientRect();
      const screen = host.querySelector(".xterm-screen").getBoundingClientRect();
      resolve({ cols: term.cols, lastChar: range.toString(), lastRight: last.right, screenRight: screen.right, screenBottom: screen.bottom, inner });
    }));
  });
});
`;

const main = `
const { app, BrowserWindow } = require("electron");
app.dock?.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 760, height: 420, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(process.argv.at(-1));
  const result = await win.webContents.executeJavaScript("window.result");
  process.stdout.write(JSON.stringify(result));
  app.exit(0);
});
`;

const folder = mkdtempSync(path.join(tmpdir(), "openorc-xterm-fit-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

// Chromium opens no window without a display, which a Linux runner has none of; macOS and Windows always have one.
const noDisplay = process.platform === "linux" && !process.env["DISPLAY"] && !process.env["WAYLAND_DISPLAY"];

it.skipIf(noDisplay)(
  "fits a padded host so a full line's last character and the last row are inside its box",
  async () => {
    const bundled = await build({ stdin: { contents: page, resolveDir: import.meta.dirname, loader: "ts" }, bundle: true, platform: "browser", format: "iife", write: false });
    const require = createRequire(import.meta.url);
    const css = readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8");
    // The host's padding and sizing as the panels draw it (pl-5 pr-2.5 pb-2.5 under Tailwind's border-box).
    const html = `<!doctype html><html><head><style>${css}
    *, ::before, ::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-size: 14px; letter-spacing: -0.005em; }
    #host { position: absolute; left: 0; top: 0; width: 640px; height: 300px; padding: 0 10px 10px 20px; }
  </style></head><body><div id="host"></div><script>${bundled.outputFiles[0]!.text}</script></body></html>`;
    const file = path.join(folder, "page.html");
    writeFileSync(file, html);
    const entry = path.join(folder, "main.cjs");
    writeFileSync(entry, main);
    const electron = require("electron") as unknown as string;
    const run = spawnSync(electron, [entry, file], { encoding: "utf8", timeout: 30_000 });
    const result = JSON.parse(run.stdout) as { cols: number; lastChar: string; lastRight: number; screenRight: number; screenBottom: number; inner: { right: number; bottom: number } };
    expect(result.lastChar).toBe("Z");
    expect(result.lastRight).toBeLessThanOrEqual(result.inner.right);
    // Each character is drawn in its own cell: the line ends where xterm's screen does, never past it.
    expect(result.lastRight).toBeLessThanOrEqual(result.screenRight + 0.5);
    expect(result.screenBottom).toBeLessThanOrEqual(result.inner.bottom);
  },
  60_000,
);
