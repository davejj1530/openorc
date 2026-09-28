/** Disposable Electron fixture: no agent calls and no production data. */
const path = require("node:path");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function build() {
  const dir = await fs.mkdtemp("/tmp/openorc-work-ui-");
  await require("./build-transcript-fixture.cjs")(dir, "work-transcript-ui.tsx");
  const env = { ...process.env, OPENORC_WORK_UI_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
async function check() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const dir = process.env.OPENORC_WORK_UI_DIR;
  const win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const read = (code) => win.webContents.executeJavaScript(code);
  const errors = [];
  win.webContents.on("console-message", (e) => {
    if (e.level === "error") errors.push(e.message);
  });
  const click = async (text) => {
    await read(`Array.from(document.querySelectorAll('button')).find(b => b.checkVisibility() && b.textContent.includes(${JSON.stringify(text)})).click()`);
    await pause(80);
  };
  const shot = async (name) => fs.writeFile(path.join(dir, name + ".png"), (await win.webContents.capturePage()).toPNG());
  try {
    await win.loadFile(path.join(dir, "index.html"));
    await pause(300);
    assert.equal(await read(`document.querySelector('.work-toggle').getAttribute('aria-expanded')`), "false");
    assert.equal(await read(`document.querySelectorAll('.agent-orb').length`), 1);
    assert.match(await read("document.body.innerText"), /Hollow stays/);
    await shot("light-collapsed");
    await click("Worked for 3m 42s");
    assert.equal(await read(`document.querySelectorAll('.work-step-toggle').length`), 2);
    await click("Used Codegraph");
    await click("Read");
    await read('document.querySelector("[data-transcript]").scrollTop = 0');
    await shot("light-expanded");
    for (const theme of ["light", "dark"]) {
      await read(`workSmoke.theme('${theme}')`);
      await pause(100);
      const area = await read(`(() => {
        const first = document.querySelector('[data-icon="WorkDelegate"]').closest('button').getBoundingClientRect();
        const last = document.querySelector('[data-icon="WorkAgent"]').closest('button').getBoundingClientRect();
        return { x: Math.floor(first.x - 12), y: Math.floor(first.y - 12), width: Math.ceil(Math.min(first.width + 24, 470)), height: Math.ceil(last.bottom - first.y + 24) };
      })()`);
      await fs.writeFile(path.join(dir, theme + "-solid-icons.png"), (await win.webContents.capturePage(area)).toPNG());
    }
    for (const theme of ["dark", "light"]) {
      await read(`workSmoke.theme('${theme}')`);
      await pause(100);
      win.setSize(480, 850);
      await pause(100);
      assert.equal(await read("document.documentElement.scrollWidth <= innerWidth"), true);
      await shot(theme + "-narrow");
    }
    win.setSize(1100, 850);
    await read(`workSmoke.theme('dark'); workSmoke.reset(); workSmoke.live()`);
    await pause(150);
    assert.equal(await read(`document.querySelector('.agent-orb').dataset.state`), "thinking");
    await click("Running command");
    await click("pnpm test --watch");
    await read("workSmoke.chunk()");
    await pause(80);
    assert.match(await read("document.body.innerText"), /live output chunk/);
    await shot("dark-live");
    await read("workSmoke.complete()");
    await pause(100);
    assert.equal(await read(`Array.from(document.querySelectorAll('.work-toggle')).at(-1).getAttribute('aria-expanded')`), "true");
    assert.match(await read("document.body.innerText"), /live output chunk/);
    assert.equal(await read(`document.querySelector('.agent-orb').dataset.state`), "idle");
    await read("workSmoke.reload()");
    await pause(100);
    assert.equal(await read(`document.querySelectorAll('.work-toggle').length`), 2);
    await read("workSmoke.reset(); workSmoke.live(); workSmoke.fail()");
    await pause(100);
    assert.match(await read("document.body.innerText"), /Failed for 12s/);
    assert.equal(await read(`Array.from(document.querySelectorAll('button')).some(b => b.checkVisibility() && b.textContent.includes('Failed') && b.textContent.includes('pnpm test'))`), false);
    await click("Failed for 12s");
    await click("Ran a command");
    assert.equal(await read(`Array.from(document.querySelectorAll('button')).some(b => b.checkVisibility() && b.textContent.includes('Failed') && b.textContent.includes('pnpm test'))`), true);
    await shot("dark-failure");
    await read("workSmoke.recovered()");
    await pause(100);
    assert.match(await read("document.body.innerText"), /Worked for 6m 21s/);
    assert.match(await read("document.body.innerText"), /Verified the animations/);
    assert.doesNotMatch(await read("document.body.innerText"), /Failed/);
    await shot("dark-recovered-collapsed");
    await click("Worked for 6m 21s");
    assert.doesNotMatch(await read("document.body.innerText"), /Failed/);
    assert.match(await read("document.body.innerText"), /Ran 3 commands/);
    await shot("dark-recovered-work-expanded");
    await click("Ran 3 commands");
    await click("cat scripts/build-mascot-review.cjs");
    await click("pnpm test");
    assert.match(await read("document.body.innerText"), /No such file or directory/);
    assert.match(await read("document.body.innerText"), /7 failed \| 30 passed/);
    assert.equal(await read(`Array.from(document.querySelectorAll('button[data-state="error"]')).every(b => b.closest('.work-content'))`), true);
    await shot("dark-recovered-expanded");
    await read("workSmoke.reload()");
    await pause(100);
    assert.match(await read("document.body.innerText"), /Worked for 6m 21s/);
    assert.doesNotMatch(await read("document.body.innerText"), /Failed/);
    await read("workSmoke.startupFailure()");
    await pause(100);
    await click("Failed for 0s");
    assert.equal(await read(`document.querySelectorAll('[data-transcript-group]').length`), 0);
    assert.equal(await read(`Array.from(document.querySelectorAll('button')).filter(b => b.textContent === 'Starting OpenCode').length`), 1);
    assert.equal(await read(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Starting OpenCode').hasAttribute('aria-expanded')`), false);
    await shot("dark-startup-status");
    assert.deepEqual(errors, []);
    console.log("PASS: light/dark, narrow layouts, nested disclosure, live output, completion, failure, recovered attempts, history, and Hollow presence. Captures: " + dir);
  } finally {
    win.destroy();
    app.quit();
  }
}
(process.versions.electron ? check() : build()).catch((e) => {
  console.error(e);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
