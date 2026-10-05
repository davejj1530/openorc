/** Exercise the installed app menu with real Electron focus, using a disposable profile. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch() {
  const dir = await fs.mkdtemp("/tmp/openorc-window-zoom-");
  const ts = require("typescript");
  for (const name of ["update-menu", "view-menu"]) {
    const source = await fs.readFile(path.join(desktop, "src/main", `${name}.ts`), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    await fs.writeFile(path.join(dir, `${name}.js`), compiled.outputText);
  }
  const env = { ...process.env, OPENORC_WINDOW_ZOOM_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  const code = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
  await fs.rm(dir, { recursive: true, force: true });
  process.exitCode = code;
}

async function check() {
  const { app, BrowserWindow, Menu, WebContentsView, webContents } = require("electron");
  const dir = process.env.OPENORC_WINDOW_ZOOM_DIR;
  app.setPath("userData", path.join(dir, "profile"));
  setTimeout(() => app.exit(2), 15000).unref();
  await app.whenReady();
  const dispose = require(path.join(dir, "update-menu.js")).installUpdateMenu({ state: { phase: "disabled", reason: "QA fixture" }, subscribe: () => () => {} });
  const menu = Menu.getApplicationMenu().items.find((item) => item.role === "viewmenu").submenu;
  const invoke = (label) => {
    const control = menu.items.find((item) => item.label === label);
    assert.ok(control, `${label} exists in the native View menu`);
    assert.equal(control.enabled, true, `${label} remains enabled`);
    // Use Electron's native command dispatch: it supplies both the focused
    // window and WebContents, which can belong to different app surfaces.
    menu._executeCommand({}, control.commandId);
  };
  const focus = async (window, contents = window.webContents) => {
    window.show();
    app.focus({ steal: true });
    window.focus();
    contents.focus();
    for (let i = 0; i < 100; i++) {
      if (BrowserWindow.getFocusedWindow() === window && webContents.getFocusedWebContents() === contents) return;
      await pause(20);
    }
    throw Error("The fixture did not receive native focus");
  };
  const window = new BrowserWindow({ show: false, width: 900, height: 600, titleBarStyle: "hiddenInset", webPreferences: { sandbox: true, contextIsolation: true } });
  await window.loadURL("data:text/html,<title>App zoom fixture</title><h1>App</h1><input>");
  const preview = new WebContentsView();
  window.contentView.addChildView(preview);
  preview.setBounds({ x: 450, y: 60, width: 450, height: 540 });
  await preview.webContents.loadURL("data:text/html,<title>Preview zoom fixture</title><h1>Preview</h1><input>");
  preview.webContents.setZoomFactor(1.5);
  for (const contents of [window.webContents, preview.webContents]) {
    await focus(window, contents);
    invoke("Zoom In");
    assert.ok(window.webContents.getZoomFactor() > 1, "Zoom In increases the app scale even when Preview has focus");
    invoke("Zoom Out");
    assert.ok(Math.abs(window.webContents.getZoomFactor() - 1) < 1e-8, "Zoom Out decreases the app scale");
    invoke("Zoom In");
    invoke("Actual Size");
    assert.equal(window.webContents.getZoomFactor(), 1, "Actual Size restores 100%");
    assert.equal(preview.webContents.getZoomFactor(), 1.5, "App zoom preserves the Preview's own zoom");
  }
  window.webContents.setZoomFactor(0.5);
  invoke("Zoom Out");
  assert.equal(window.webContents.getZoomFactor(), 0.5, "Minimum zoom is 50%");
  window.webContents.setZoomFactor(3);
  invoke("Zoom In");
  assert.equal(window.webContents.getZoomFactor(), 3, "Maximum zoom is 300%");
  invoke("Actual Size");
  const second = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await second.loadURL("data:text/html,<title>Second app zoom fixture</title><h1>Second window</h1>");
  await focus(second);
  invoke("Zoom In");
  assert.ok(second.webContents.getZoomFactor() > 1, "The focused app window receives the zoom command");
  assert.equal(window.webContents.getZoomFactor(), 1, "Another app window is unaffected");
  dispose();
  console.log("PASS: native app zoom with app/Preview focus, reset, 50–300% bounds, independent Preview zoom, and multiple windows");
  preview.webContents.close();
  second.destroy();
  window.destroy();
  app.exit(0);
}

(process.versions.electron ? check() : launch()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
