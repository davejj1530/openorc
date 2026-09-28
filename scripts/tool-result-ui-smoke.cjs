/** Real Chromium verification of rich results with disposable synthetic data. */
const path = require("node:path");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function build() {
  const dir = await fs.mkdtemp("/tmp/openorc-tool-result-smoke-");
  await require("./build-transcript-fixture.cjs")(dir, "tool-result-ui.tsx");
  const env = { ...process.env, OPENORC_TOOL_RESULT_UI_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
async function check() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const dir = process.env.OPENORC_TOOL_RESULT_UI_DIR;
  const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const read = (code) => win.webContents.executeJavaScript(code);
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const click = async (name) => {
    await read(
      `Array.from(document.querySelectorAll('button')).find(b => b.checkVisibility() && (b.getAttribute('aria-label') === ${JSON.stringify(name)} || b.textContent.trim() === ${JSON.stringify(name)})).click()`,
    );
    await pause(100);
  };
  const expand = async () => {
    await read(`document.querySelector('button[aria-expanded="false"]')?.click()`);
    await pause(100);
  };
  const shot = async (name) => fs.writeFile(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const images = () => read(`Array.from(document.querySelectorAll('.tool-detail img')).map(i => ({loaded:i.complete && i.naturalWidth > 0, fit:getComputedStyle(i).objectFit}))`);
  const fits = () =>
    read(
      `document.documentElement.scrollWidth <= innerWidth && Array.from(document.querySelectorAll('button')).filter(b => b.checkVisibility()).every(b => { const r=b.getBoundingClientRect();return r.left >= 0 && r.right <= innerWidth; })`,
    );
  try {
    await win.loadFile(path.join(dir, "index.html"));
    await pause(300);
    await expand();
    assert.deepEqual(
      await images(),
      Array.from({ length: 3 }, () => ({ loaded: true, fit: "contain" })),
    );
    for (const width of [1100, 390]) {
      win.setSize(width, 900);
      await pause(100);
      for (let theme = 0; theme < 2; theme++) {
        assert.equal(await fits(), true, `Layout fits at ${width}px`);
        const mode = await read("document.documentElement.dataset.theme");
        await shot(`${mode}-${width}`);
        await read(`document.querySelector('[aria-label="View image: Tool image 2"]').focus()`);
        await click("View image: Tool image 2");
        assert.equal(await read(`!!document.querySelector('[role="dialog"] img')?.naturalWidth`), true);
        assert.equal(await fits(), true, `Image viewer fits at ${width}px`);
        assert.equal(
          await read(`(() => { const d=document.querySelector('[role="dialog"] header p'); return d.clientHeight <= parseFloat(getComputedStyle(d).lineHeight) + 1; })()`),
          true,
          "Image dimensions stay on one line",
        );
        await click("Zoom in");
        await click("Fit");
        await shot(`${mode}-${width}-viewer`);
        await click("Close image viewer");
        assert.equal(await read("document.activeElement.getAttribute('aria-label')"), "View image: Tool image 2");
        await click("Switch theme");
      }
    }
    win.setSize(1100, 900);
    await click("Claude");
    assert.equal((await images()).length, 3);
    await click("Reload history");
    await expand();
    assert.equal((await images()).length, 3);
    await click("Image only");
    assert.equal((await images()).length, 1);
    await click("Resources");
    assert.equal((await images())[0].loaded, true);
    assert.match(await read("document.body.innerText"), /A text resource stays readable/);
    await click("Plain output");
    assert.match(await read("document.body.innerText"), /<script>This stays literal.<\/script>/);
    await click("Unsupported");
    assert.match(await read("document.body.innerText"), /Image preview unavailable/);
    await read(`Array.from(document.querySelectorAll('summary')).find(s => s.textContent === 'Result data').click()`);
    await pause(100);
    assert.equal(await read("document.body.innerText.includes('PHN2Zz4=')"), false);
    await click("Broken image");
    await pause(150);
    assert.match(await read("document.body.innerText"), /Image unavailable/);
    await click("Codex");
    assert.deepEqual(
      await images(),
      Array.from({ length: 3 }, () => ({ loaded: true, fit: "contain" })),
    );
    assert.deepEqual(errors, []);
    console.log("PASS: Codex/Claude content, history, images/viewer/focus, resources, fallbacks, light/dark and narrow layouts. Captures: " + dir);
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
