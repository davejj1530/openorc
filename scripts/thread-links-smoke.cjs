/** Native link gestures and real sidebar navigation, with a disposable profile. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const desktop = path.join(root, "apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function build() {
  const dir = await fs.mkdtemp("/tmp/openorc-thread-links-");
  await require("./build-transcript-fixture.cjs")(dir, "thread-links-ui.tsx");
  const { build } = require(require.resolve("esbuild", { paths: [path.dirname(require.resolve("tsx/package.json", { paths: [root] }))] }));
  await build({
    stdin: {
      resolveDir: root,
      contents: `export * from './apps/desktop/src/main/browser-pane'; export * from './apps/desktop/src/main/link-navigation'; export * from './apps/desktop/src/main/image-context-menu';`,
    },
    outfile: path.join(dir, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
  await build({
    entryPoints: [path.join(desktop, "src/preload/index.ts")],
    outfile: path.join(dir, "preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    define: { __OPENORC_QA__: "false" },
  });
  const server = require("node:http").createServer(async (req, res) => {
    if (req.url.startsWith("/page-")) {
      res.setHeader("Content-Type", "text/html");
      res.end(`<title>Linked page</title><h1>Opened ${req.url}</h1>`);
      return;
    }
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      const file = path.join(dir, pathname === "/" ? "index.html" : pathname);
      if (!file.startsWith(dir + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      res.setHeader("Content-Type", contentType(file));
      res.end(await fs.readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const site = `http://127.0.0.1:${server.address().port}`;
  console.log(JSON.stringify({ site, dir }));
  const env = { ...process.env, OPENORC_LINK_SMOKE_DIR: dir, OPENORC_LINK_SMOKE_SITE: site };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    if (!process.argv.includes("--serve")) server.close();
    process.exitCode = code ?? 1;
  });
}

async function check() {
  const { app, BrowserWindow, ipcMain, Menu, clipboard, shell } = require("electron");
  const dir = process.env.OPENORC_LINK_SMOKE_DIR;
  const site = process.env.OPENORC_LINK_SMOKE_SITE;
  app.setPath("userData", path.join(dir, "profile"));
  await app.whenReady();
  const api = require(path.join(dir, "main.cjs"));
  const external = [];
  let copied = null;
  clipboard.writeText = (text) => {
    copied = text;
  };
  shell.openExternal = async (url) => {
    external.push(url);
  };
  const win = new BrowserWindow({ show: false, width: 1060, height: 720, webPreferences: { preload: path.join(dir, "preload.cjs"), sandbox: true, contextIsolation: true } });
  ipcMain.handle("window:appearance", () => {});
  api.installBrowserPane(ipcMain, { getWindow: () => win });
  api.installLinkNavigation(win, (url) => url === site + "/");
  api.installImageContextMenu(win, dir);
  let menu = null;
  const buildMenu = Menu.buildFromTemplate;
  Menu.buildFromTemplate = (template) => {
    menu = buildMenu(template);
    menu.popup = () => {};
    return menu;
  };
  const read = (code) => win.webContents.executeJavaScript(code);
  const until = async (condition) => {
    for (let i = 0; i < 100; i++) {
      if (await condition()) return;
      await pause(50);
    }
    throw Error("Timed out waiting for link navigation");
  };
  const click = async (label, button = "left") => {
    const point = await read(
      `(() => { const a=Array.from(document.querySelectorAll('a')).find(a=>a.textContent===${JSON.stringify(label)}); const r=a.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`,
    );
    win.webContents.sendInputEvent({ type: "mouseDown", ...point, button, clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", ...point, button, clickCount: 1 });
  };
  const page = () => win.contentView.children.find((view) => view.webContents)?.webContents;
  const expectPreview = async (url) => {
    await until(() => read("document.querySelector('.panel-shell[data-open=true] [role=tab][aria-selected=true]')?.getAttribute('aria-label') === 'Preview'"));
    await until(() => page()?.getURL() === url);
    await until(() => read(`document.querySelector('input[aria-label="Preview address"]')?.value === ${JSON.stringify(url)}`));
    await until(() => win.contentView.children.some((view) => view.webContents === page() && view.getVisible() && view.getBounds().width > 0 && view.getBounds().height > 0));
  };
  try {
    await win.loadURL(site);
    win.showInactive();
    await until(() => read("document.querySelectorAll('a').length === 3"));
    assert.equal(await read("typeof window.openorc?.browser"), "object", "The production preload is available");
    await click("first page");
    await expectPreview(site + "/page-a");
    assert.equal(await read("!!document.querySelector('[role=dialog]')"), false);
    assert.deepEqual(external, []);
    await read("document.querySelector('[aria-label=\"Hide panel\"]').click()");
    await until(() => read("document.querySelector('.panel-shell')?.getAttribute('data-open') === 'false'"));
    await pause(32);
    assert.equal(
      win.contentView.children.some((view) => view.webContents && view.getVisible()),
      false,
      "Closing the panel hides the native preview before the shell finishes animating",
    );
    await click("second page");
    await expectPreview(site + "/page-b");
    await read("document.querySelector('[data-show-tasks]').click()");
    await until(() => read("document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-label') === 'Tasks'"));
    await click("document link");
    await expectPreview(site + "/page-c");
    await click("first page", "middle");
    await until(() => page()?.getURL() === site + "/page-a");
    await read("Array.from(document.querySelectorAll('a')).find(a => a.textContent === 'second page').focus()");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await until(() => page()?.getURL() === site + "/page-b");
    await click("second page", "right");
    await until(() => menu !== null);
    const labels = menu.items.filter((item) => item.type !== "separator").map((item) => item.label);
    assert(labels.includes("Open in sidebar") && labels.includes("Open in default browser") && labels.includes("Copy link address"));
    menu.items.find((item) => item.label === "Copy link address").click();
    assert.equal(copied, site + "/page-b");
    menu.items.find((item) => item.label === "Open in default browser").click();
    assert.deepEqual(external, [site + "/page-b"]);
    menu.items.find((item) => item.label === "Open in sidebar").click();
    await until(() => page()?.getURL() === site + "/page-b");
    for (const theme of ["light", "dark"]) {
      await read("window.getSelection().removeAllRanges()");
      await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await pause(100);
      await fs.writeFile(path.join(dir, `${theme}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await read("document.documentElement.dataset.transparentShell = 'true'");
    await read("document.querySelector('[aria-label=\"Expand panel\"]').click()");
    await until(() => read("document.querySelector('.panel-shell').dataset.expanded === 'true'"));
    const paneFill = () => read("getComputedStyle(document.querySelector('.panel-pane')).backgroundColor");
    assert.match(await paneFill(), /^rgb\(/, "Expanded panels must cover the conversation with an opaque surface when transparency is enabled");
    await fs.writeFile(path.join(dir, "transparent-expanded.png"), (await win.webContents.capturePage()).toPNG());
    await read("document.querySelector('[aria-label=\"Collapse panel\"]').click()");
    win.setContentSize(720, 720);
    await until(() => read("getComputedStyle(document.querySelector('.panel-shell')).position === 'absolute'"));
    assert.match(await paneFill(), /^rgb\(/, "Narrow overlay panels must also cover the conversation with an opaque surface");
    await fs.writeFile(path.join(dir, "transparent-compact.png"), (await win.webContents.capturePage()).toPNG());
    assert.equal(win.webContents.getURL(), site + "/");
    page().debugger.attach("1.3");
    const pageImage = await page().debugger.sendCommand("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(dir, "page.png"), Buffer.from(pageImage.data, "base64"));
    assert.equal(await page().executeJavaScript("typeof window.openorc"), "undefined");
    console.log(JSON.stringify({ passed: true, labels, screenshots: [path.join(dir, "light.png"), path.join(dir, "dark.png")] }));
  } finally {
    api.closeAllPanes();
    win.destroy();
    app.quit();
  }
}
(process.env.OPENORC_LINK_SMOKE_DIR ? check() : build()).catch((error) => {
  console.error(error);
  process.exit(1);
});

function contentType(file) {
  if (file.endsWith(".js")) return "text/javascript";
  if (file.endsWith(".css")) return "text/css";
  return "text/html";
}
