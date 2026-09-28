/** Disposable renderer fixture: no app database, credentials, or provider calls. */
const path = require("node:path");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch() {
  const dir = await fs.mkdtemp("/tmp/openorc-recovery-ui-");
  await require("./build-transcript-fixture.cjs")(dir, "provider-recovery-ui.tsx");
  const electron = require(require.resolve("electron", { paths: [path.join(root, "apps/desktop")] }));
  const env = { ...process.env, OPENORC_RECOVERY_UI_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(electron, [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

async function verify() {
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_RECOVERY_UI_DIR;
  app.setPath("userData", path.join(dir, "profile"));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1200, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const output = path.join(root, "output/qa/provider-recovery");
  await fs.mkdir(output, { recursive: true });
  const read = (code) => win.webContents.executeJavaScript(code);
  const click = async (label) => {
    await read(`Array.from(document.querySelectorAll('button,[role="menuitem"]')).find(e => e.textContent.trim() === ${JSON.stringify(label)}).click()`);
    await pause(150);
  };
  const shot = async (name) => fs.writeFile(path.join(output, name + ".png"), (await win.webContents.capturePage()).toPNG());
  try {
    await win.loadFile(path.join(dir, "index.html"));
    await pause(400);
    for (const theme of ["light", "dark"]) {
      await read(`recoveryFixture.theme(${JSON.stringify(theme)})`);
      for (const width of [1200, 522]) {
        win.setContentSize(width, 1000);
        await pause(200);
        await shot(`${theme}-${width}`);
        await click("Use reset");
        assert.match(await read("document.querySelector('[role=dialog]').textContent"), /fixture@example.test/);
        await shot(`${theme}-${width}-confirm`);
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await pause(200);
        assert.equal(await read("Boolean(document.querySelector('[role=dialog]'))"), false);
      }
    }
    win.setContentSize(1200, 1000);
    await read(`Array.from(document.querySelectorAll('button')).find(e => e.textContent.includes('saved-model-fixture')).click()`);
    await pause(200);
    assert.match(await read("document.body.innerText"), /Saved model: saved-model-fixture/);
    await shot("dark-model-picker");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await pause(200);
    await click("Use reset");
    await click("Confirm reset");
    assert.match(await read("document.body.innerText"), /1 reset available/);
    assert.match(await read("document.body.innerText"), /Reset used/);
    console.log("PASS: light/dark, desktop/narrow, Escape dismissal, preserved saved model, and simulated reset. Captures: " + output);
  } finally {
    win.destroy();
    app.quit();
  }
}
(process.versions.electron ? verify() : launch()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
