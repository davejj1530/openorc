/** Tests the real editor and attachment service in a disposable Electron profile; no agent calls. */
const path = require("node:path");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function buildAndRun() {
  const dir = await fs.mkdtemp("/tmp/openorc-editor-");
  await require("./build-transcript-fixture.cjs")(dir, "task-editor-ui.tsx");
  const { build } = require(require.resolve("esbuild", { paths: [path.dirname(require.resolve("tsx/package.json", { paths: [path.resolve(__dirname, "..")] }))] }));
  await build({ entryPoints: [path.resolve(__dirname, "../packages/core/src/services/attachments.ts")], outfile: path.join(dir, "attachments.cjs"), bundle: true, platform: "node", format: "cjs" });
  await build({ entryPoints: [path.join(desktop, "src/main/image-assets.ts")], outfile: path.join(dir, "image-assets.cjs"), bundle: true, platform: "node", format: "cjs" });
  await fs.writeFile(
    path.join(dir, "preload.cjs"),
    `const {contextBridge, ipcRenderer} = require('electron'); contextBridge.exposeInMainWorld('editorFixture', {save: params => ipcRenderer.invoke('save-image', params)});`,
  );
  const env = { ...process.env, OPENORC_EDITOR_UI_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
async function run() {
  const { app, BrowserWindow, protocol, clipboard, ClipboardItem, nativeImage, ipcMain } = require("electron");
  const dir = process.env.OPENORC_EDITOR_UI_DIR;
  app.setPath("userData", path.join(dir, "profile"));
  protocol.registerSchemesAsPrivileged([{ scheme: "openorc-asset", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  await app.whenReady();
  protocol.handle("openorc-asset", (request) => require(path.join(dir, "image-assets.cjs")).imageAssetResponse(request, dir));
  const attachments = new (require(path.join(dir, "attachments.cjs")).AttachmentService)(dir);
  let delay = 0;
  let fail = false;
  let imports = 0;
  ipcMain.handle("save-image", async (_event, params) => {
    imports++;
    if (delay) await pause(delay);
    if (fail) throw new Error("Fixture disk unavailable");
    return attachments.save(params);
  });
  const win = new BrowserWindow({ show: false, width: 1050, height: 900, webPreferences: { preload: path.join(dir, "preload.cjs"), contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const read = (code) => win.webContents.executeJavaScript(code);
  const click = (selector) => read(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await pause(70);
  };
  const until = async (code, label) => {
    for (let n = 0; n < 150; n++) {
      if (await read(code)) return;
      await pause(50);
    }
    throw new Error("Timed out: " + label);
  };
  const load = async (value) => {
    await read(`editorSmoke.load(${JSON.stringify(value)})`);
    await until(`Boolean(document.querySelector('.task-rich-editor'))`, "editor mount");
    await pause(100);
  };
  const focusEnd = async () => {
    await read(
      `(() => {const el=document.querySelector('.task-rich-editor');el.focus();const range=document.createRange();range.selectNodeContents(el);range.collapse(false);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);})()`,
    );
  };
  const type = async (text) => {
    await win.webContents.insertText(text);
    await pause(90);
  };
  const shot = async (name) => fs.writeFile(path.join(dir, name + ".png"), (await win.webContents.capturePage()).toPNG());
  const pasteImage = async () => {
    const bitmap = Buffer.alloc(640 * 320 * 4);
    for (let i = 0; i < bitmap.length; i += 4) {
      bitmap[i] = 230;
      bitmap[i + 1] = 180;
      bitmap[i + 2] = 75;
      bitmap[i + 3] = 255;
    }
    await clipboard.write([new ClipboardItem({ "image/png": new Blob([nativeImage.createFromBitmap(bitmap, { width: 640, height: 320 }).toPNG()], { type: "image/png" }) })]);
    win.webContents.paste();
    await pause(100);
  };
  const previousClipboard = await Promise.all(
    (await clipboard.read()).map(async (item) => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async (type) => [type, await item.getType(type)]))))),
  );
  try {
    await win.loadFile(path.join(dir, "index.html"));
    await until(`Boolean(document.querySelector('.task-rich-editor'))`, "editor ready");
    assert.equal(await read(`document.querySelectorAll('[data-type="taskItem"]').length`), 2);
    await click('[data-type="taskItem"] input');
    assert.match(await read("editorSmoke.value()"), /- \[x\] Preserve existing content/);
    const original = await read("editorSmoke.value()");
    await pause(200);
    assert.equal(await read("editorSmoke.value()"), original, "mount must not rewrite Markdown");
    await load("");
    await focusEnd();
    await type("/hea");
    await until(`document.querySelectorAll('.task-insert-menu [role=option]').length === 3`, "filtered headings");
    await key("Down");
    assert.match(await read(`document.querySelector('.task-insert-menu [aria-selected=true]')?.innerText`), /Heading 2/);
    await key("Enter");
    await type("Visual acceptance criteria");
    assert.match(await read("editorSmoke.value()"), /^## Visual acceptance criteria/);
    await key("Enter");
    await type("Before screenshot.");
    await key("Enter");
    delay = 500;
    await pasteImage();
    await type("After screenshot.");
    await until(`document.querySelector('[data-image-state="saved"] img')?.naturalWidth === 640`, "saved screenshot");
    assert.match(await read("editorSmoke.value()"), /Before screenshot\.[\s\S]*!\[[\s\S]*After screenshot\./, "image stays at its insertion point while typing");
    assert.doesNotMatch(await read("editorSmoke.value()"), /blob:|data:image|openorc-pending/);
    const withImage = await read("editorSmoke.value()");
    await win.reload();
    await until(`document.querySelector('[data-image-state="saved"] img')?.naturalWidth === 640`, "restart restores image");
    assert.equal(await read("editorSmoke.value()"), withImage);
    await click('[aria-label="View image: image.png"]');
    await until(`Boolean(document.querySelector('[role=dialog]'))`, "image viewer");
    await key("Escape");

    await load("Retry example\n\n");
    await focusEnd();
    fail = true;
    delay = 0;
    await pasteImage();
    await until(`Boolean(document.querySelector('[data-image-state="error"]'))`, "failed image");
    await read(`[...document.querySelectorAll('button')].find(el=>el.textContent==='Save task').click()`);
    await until(`document.body.innerText.includes('Save blocked')`, "failed image blocks save");
    fail = false;
    await read(`[...document.querySelectorAll('.task-image-error button')].find(el=>el.textContent.includes('Retry')).click()`);
    await until(`Boolean(document.querySelector('[data-image-state="saved"]'))`, "retry saved");

    await load("Pending restart\n\n");
    await focusEnd();
    delay = 900;
    await pasteImage();
    await until(`editorSmoke.value().includes('openorc-pending://')`, "durable pending reference");
    const before = imports;
    await win.reload();
    await until(`document.querySelector('[data-image-state="saved"] img')?.naturalWidth === 640`, "pending import recovered");
    assert.ok(imports <= before + 1, "at most one recovery import");

    await load("Remove before save\n\n");
    await focusEnd();
    delay = 900;
    await pasteImage();
    await until(`Boolean(document.querySelector('[data-image-state="saving"]'))`, "saving image");
    await read(`[...document.querySelectorAll('.task-image-tools button')].find(el=>el.textContent.includes('Remove')).click()`);
    await pause(1100);
    assert.equal(await read(`document.querySelectorAll('.task-image').length`), 0, "late save does not resurrect deleted image");
    delay = 0;

    await load("");
    await focusEnd();
    await type("/code");
    await key("Enter");
    await type("/image");
    assert.equal(await read(`Boolean(document.querySelector('.task-insert-menu'))`), false, "no slash commands in code");
    await load("");
    await focusEnd();
    await type("/usr/local");
    assert.equal(await read(`Boolean(document.querySelector('.task-insert-menu'))`), false, "no slash commands for paths");
    await load("");
    await focusEnd();
    await type("/image");
    await key("Escape");
    assert.equal(await read(`Boolean(document.querySelector('.task-insert-menu'))`), false);
    assert.match(await read("editorSmoke.value()"), /\/image/, "escape keeps the query");

    await load("Format this");
    await focusEnd();
    await read(
      `(() => {const range=document.createRange();range.selectNodeContents(document.querySelector('.task-rich-editor p'));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);})()`,
    );
    await until(`Boolean(document.querySelector('[aria-label="Text formatting"]'))`, "format toolbar");
    await click('[aria-label="Bold (⌘B)"]');
    await pause(100);
    assert.match(await read("editorSmoke.value()"), /\*\*Format this\*\*/);
    await key("z", ["meta"]);
    assert.doesNotMatch(await read("editorSmoke.value()"), /\*\*/);
    await key("z", ["meta", "shift"]);
    assert.match(await read("editorSmoke.value()"), /\*\*/);
    await load("");
    await focusEnd();
    await clipboard.write([new ClipboardItem({ "text/plain": "## Pasted heading\n\n- [ ] Pasted checklist" })]);
    win.webContents.paste();
    await until(`Boolean(document.querySelector('.task-rich-editor h2'))`, "Markdown paste is formatted");
    assert.equal(await read(`document.querySelectorAll('[data-type="taskItem"]').length`), 1);
    await load("Undo image\n\n");
    await focusEnd();
    await pasteImage();
    await until(`Boolean(document.querySelector('[data-image-state="saved"]'))`, "image ready for undo");
    await key("z", ["meta"]);
    assert.equal(await read(`document.querySelectorAll('.task-image').length`), 0);
    await key("z", ["meta", "shift"]);
    await until(`document.querySelector('[data-image-state="saved"] img')?.naturalWidth === 640`, "redo retains saved image");

    const legacy = "<details><summary>Keep me</summary>Hidden content</details>\n\n$$x^2$$";
    await load(legacy);
    assert.equal(await read(`document.querySelector('[aria-label="Task description Markdown"]').value`), legacy);
    assert.equal(await read("editorSmoke.value()"), legacy);
    await load(withImage + "\n\n- [ ] Match the reference\n- [x] Keep the draft safe");
    for (const theme of ["light", "dark"]) {
      await read(`editorSmoke.theme('${theme}')`);
      for (const width of [1050, 420]) {
        win.setSize(width, 900);
        await pause(150);
        assert.equal(await read(`document.querySelector('.task-document').scrollWidth <= document.querySelector('.task-document').clientWidth`), true, "content fits " + width);
        await shot("editor-" + theme + "-" + width);
      }
    }
    win.setSize(1050, 900);
    await focusEnd();
    await key("Enter");
    await type("/");
    await shot("slash-menu");
    const unexpected = errors.filter((value) => !value.includes("Fixture disk unavailable") && !value.includes("Electron Security Warning"));
    assert.deepEqual(unexpected, []);
    console.log("PASS: real clipboard image paste, async placement, recovery after reload, retries, deletion during save, slash keyboard commands, source preservation, light/dark and narrow layouts");
    console.log("Screenshots: " + dir);
  } catch (error) {
    await shot("failure");
    console.error(await read("document.body.innerText"), errors, dir);
    throw error;
  } finally {
    await clipboard.write(previousClipboard);
    win.destroy();
    app.quit();
  }
}
(process.versions.electron ? run() : buildAndRun()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
