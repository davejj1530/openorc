/** Real Chromium check that a permission request shows its command's last line, and its answers in view, before Allow. */
const path = require("node:path");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function build() {
  const dir = await fs.mkdtemp("/tmp/openorc-approval-card-smoke-");
  await require("./build-transcript-fixture.cjs")(dir, "approval-card-ui.tsx");
  const env = { ...process.env, OPENORC_APPROVAL_CARD_UI_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
async function check() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const dir = process.env.OPENORC_APPROVAL_CARD_UI_DIR;
  const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const read = (code) => win.webContents.executeJavaScript(code);
  // The detail box shows all of its text when nothing in it scrolls out of view, and the card fits the window.
  const card = () =>
    read(`(() => {
      const d = document.querySelector('.approval-card-detail');
      return { whole: d.scrollHeight <= d.clientHeight + 1, text: d.textContent, fits: document.querySelector('.approval-card').getBoundingClientRect().bottom <= innerHeight };
    })()`);
  // Each request's summary ends where its last line does.
  const requests = { heredoc: /git push --force origin main$/, script: /git push --force origin main$/, ids: /1119\n \]\n\}$/ };
  try {
    for (const [name, end] of Object.entries(requests)) {
      await win.loadFile(path.join(dir, "index.html"), { query: { request: name } });
      await pause(300);
      for (const width of [1100, 390]) {
        win.setSize(width, 900);
        await pause(100);
        const summary = await card();
        assert.match(summary.text, end, `The ${name} request ends in its last line at ${width}px`);
        assert.equal(summary.whole, true, `The whole ${name} summary shows at ${width}px`);
        assert.equal(summary.fits, true, `The ${name} card and its answers fit the window at ${width}px`);
        await win.webContents.capturePage().then((image) => fs.writeFile(path.join(dir, `${name}-${width}.png`), image.toPNG()));
      }
    }
    console.log("PASS: each request's last line and its answers show before Allow, wide and narrow. Captures: " + dir);
  } finally {
    win.destroy();
    app.quit();
  }
}
(process.versions.electron ? check() : build()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
