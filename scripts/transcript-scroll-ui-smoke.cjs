/** Exercise production Transcript scrolling in Chromium without app data or agents. */
const path = require("node:path");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const desktop = path.join(root, "apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildAndRun() {
  const dir = await fs.mkdtemp("/tmp/openorc-scroll-ui-");
  await require("./build-transcript-fixture.cjs")(dir, "transcript-scroll-ui.tsx");
  const env = { ...process.env, OPENORC_SCROLL_UI_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", async (code) => {
    await fs.rm(dir, { recursive: true, force: true });
    process.exitCode = code ?? 1;
  });
}

async function checkUI() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const read = (code) => win.webContents.executeJavaScript(code);
  try {
    await win.loadFile(path.join(process.env.OPENORC_SCROLL_UI_DIR, "index.html"));
    await pause(300);
    await read('window.el = document.querySelector("[data-transcript]")');
    assert.ok(await read("el.scrollHeight > el.clientHeight"));
    const before = await read(`el.dispatchEvent(new WheelEvent('wheel', {deltaY:-20, bubbles:true})); el.scrollTop -= 20; el.dispatchEvent(new Event('scroll')); el.scrollTop`);
    await read("scrollSmoke.update()");
    await pause(100);
    assert.ok(await read(`el.scrollTop <= ${before} + 1`), "A small upward scroll must survive a streaming update");
    await read("scrollSmoke.nextRun()");
    await pause(100);
    assert.ok(await read(`el.scrollTop <= ${before} + 1`), "A new run in the same thread must preserve reading position");
    await read('el.firstElementChild.style.paddingBottom = "120px"');
    await pause(100);
    assert.ok(await read(`el.scrollTop <= ${before} + 1`), "Child layout growth must preserve reading position");
    await read('el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event("scroll")); scrollSmoke.update()');
    await pause(100);
    assert.ok(await read("el.scrollHeight - el.scrollTop - el.clientHeight <= 1"), "Returning to the bottom must resume following");
    await read('el.firstElementChild.style.paddingBottom = "240px"');
    await pause(100);
    assert.ok(await read("el.scrollHeight - el.scrollTop - el.clientHeight <= 1"), "Pinned transcript must follow child layout growth");
    // A render can arrive between wheel input and the native scroll event.
    const raceTop = await read(
      `(() => { el.dispatchEvent(new WheelEvent('wheel', {deltaY:-12, bubbles:true})); el.scrollTop -= 12; const position = el.scrollTop; scrollSmoke.update(); return position; })()`,
    );
    await pause(100);
    assert.ok(await read(`el.scrollTop <= ${raceTop} + 1`), "Upward intent must release following before the scroll event");
    await read("scrollSmoke.nextThread()");
    await pause(100);
    assert.ok(await read("el.scrollHeight - el.scrollTop - el.clientHeight <= 1"), "A different thread must open at its tail");
    // Native scroll position changes cover scrollbar and keyboard scrolling.
    const dragTop = await read('el.scrollTop -= 30; el.dispatchEvent(new Event("scroll")); el.scrollTop');
    await read("scrollSmoke.update()");
    await pause(100);
    assert.ok(await read(`el.scrollTop <= ${dragTop} + 1`), "Upward scrolling without a wheel must release following");
    console.log("PASS: upward scroll, input/render race, child resize, resume at bottom, new run, thread switch and scrollbar scrolling.");
  } finally {
    win.destroy();
    app.quit();
  }
}
(process.versions.electron ? checkUI() : buildAndRun()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
