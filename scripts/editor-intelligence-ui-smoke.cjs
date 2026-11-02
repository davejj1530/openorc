/** Run against editor-intelligence-preview.mts; disposable Chromium profile, production editor and real core. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const root = path.resolve(__dirname, "..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openorc-editor-ui-"));
  const electron = require(require.resolve("electron", { paths: [path.join(root, "apps/desktop")] }));
  const env = { ...process.env, OPENORC_EDITOR_UI_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(electron, [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

async function check() {
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_EDITOR_UI_DIR;
  app.setPath("userData", path.join(dir, "profile"));
  await app.whenReady();
  const win = new BrowserWindow({ width: 1000, height: 780, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const read = (code) => win.webContents.executeJavaScript(code);
  const waitFor = async (code, label) => {
    for (let i = 0; i < 120; i++) {
      if (await read(code)) return;
      await pause(100);
    }
    throw Error("Timed out: " + label);
  };
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await pause(100);
  };
  const button = async (label) => {
    const selector = `[aria-label=${JSON.stringify(label)}]`;
    await read(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await pause(150);
  };
  const menu = async (label) => {
    await button("File actions");
    await waitFor(`Array.from(document.querySelectorAll('[role=menuitem]')).some(e=>e.textContent.trim()===${JSON.stringify(label)})`, "menu " + label);
    await read(`Array.from(document.querySelectorAll('[role=menuitem]')).find(e=>e.textContent.trim()===${JSON.stringify(label)}).click()`);
    await pause(150);
  };
  const open = async (file, needle, offset = 0) => {
    await read(`window.editorQA.openAt(${JSON.stringify(file)},${JSON.stringify(needle)},${offset})`);
    await waitFor(`document.querySelector('.cm-content')?.getAttribute('aria-label')===${JSON.stringify(file)}`, "open " + file);
    await pause(500);
  };
  const selected = (file) => `window.editorQA.snapshot().selected?.path===${JSON.stringify(file)}`;
  const shot = async (name) => {
    await fs.writeFile(path.join(dir, name + ".png"), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await win.loadURL(process.env.OPENORC_EDITOR_UI_URL ?? "http://127.0.0.1:5189/");
    await waitFor("document.querySelector('.file-problems-status')?.textContent==='1 problem'", "diagnostics");
    await key("F12");
    await waitFor(selected("math.ts"), "F12 definition");
    await button("Go back in code");
    await waitFor(selected("main.ts"), "back history");
    await menu("Go to definition");
    await waitFor(selected("math.ts"), "menu definition");
    await button("Go back in code");
    await waitFor(selected("main.ts"), "back from menu definition");
    await open("main.ts", "double(2)", 2);
    await key("F12", ["shift"]);
    await waitFor("document.querySelector('[aria-label=References]')?.textContent.includes('math.ts')", "references");
    assert.match(await read("document.querySelector('[aria-label=References]').textContent"), /main\.ts/);
    await read("Array.from(document.querySelectorAll('.file-insights-row')).find(e=>e.textContent.includes('math.ts')).click()");
    await waitFor(selected("math.ts"), "reference navigation");
    assert.equal(await read("!!document.querySelector('[aria-label=References]')"), true);
    await button("Close references");
    await open("main.ts", "double(2)", 2);
    const coords = await read(`(()=>{
      const line=Array.from(document.querySelectorAll('.cm-line')).find(e=>e.textContent.includes('answer ='));
      const walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);let node;
      while(node=walker.nextNode()){const at=node.textContent.indexOf('double');if(at>=0){const r=document.createRange();r.setStart(node,at+1);r.setEnd(node,at+3);const b=r.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}}}
    })()`);
    assert.ok(coords, "definition coordinates");
    win.webContents.sendInputEvent({ type: "mouseMove", ...coords });
    await waitFor("document.querySelector('.cm-editor-information')?.textContent.includes('Return twice the supplied value.')", "hover documentation");
    await waitFor("(()=>{const r=document.querySelector('.cm-editor-information')?.getBoundingClientRect();return r && r.top>=0 && r.bottom<=innerHeight})()", "hover positioning");
    await shot("hover-light");
    const modifiers = [process.platform === "darwin" ? "meta" : "control"];
    win.webContents.sendInputEvent({ type: "mouseMove", ...coords, modifiers });
    await waitFor("!!document.querySelector('.cm-definition-link')", "modifier underline");
    win.webContents.sendInputEvent({ type: "mouseDown", ...coords, button: "left", clickCount: 1, modifiers });
    win.webContents.sendInputEvent({ type: "mouseUp", ...coords, button: "left", clickCount: 1, modifiers });
    await waitFor(selected("math.ts"), "modifier-click definition");
    await open("main.ts", "dobule", 2);
    await waitFor("document.querySelector('.file-problems-status')?.textContent==='1 problem'", "quick-fix diagnostics");
    await menu("Quick fixes");
    await waitFor("document.querySelector('[aria-label=\"Quick fixes\"]')?.textContent.includes('double')", "spelling fix");
    await read("document.querySelector('.file-insights-row').click()");
    await waitFor("document.querySelector('.cm-content').textContent.includes('misspelled = double(3)')", "quick-fix draft");
    const disk = await read("fetch('/disk').then(r=>r.json())");
    assert.match(disk.main, /dobule\(3\)/, "quick fix leaves disk untouched");
    await key("z", modifiers);
    await waitFor("document.querySelector('.cm-content').textContent.includes('misspelled = dobule(3)')", "undo quick fix");
    await key("z", [...modifiers, "shift"]);
    await waitFor("document.querySelector('.cm-content').textContent.includes('misspelled = double(3)')", "redo quick fix");
    await open("main.ts", "person.firstName", 7);
    await key("Space", ["control"]);
    await waitFor("document.querySelector('.cm-tooltip-autocomplete')?.textContent.includes('firstName')", "member completion");
    await pause(250);
    await key("ArrowDown");
    await key("Enter");
    assert.equal(await read("Array.from(document.querySelectorAll('.cm-line')).some(e=>e.textContent==='  return person.firstName;')"), true, "completion replaces the full existing member");
    await button("Outline");
    await waitFor("document.querySelector('[aria-label=Outline] .file-insights-list')?.textContent.includes('greeting')", "outline");
    await shot("outline-light");
    await read("Array.from(document.querySelectorAll('.file-insights-row')).find(e=>e.textContent.includes('greeting')).click()");
    assert.equal((await read("window.editorQA.snapshot()")).selected.line, 6);
    await button("Close outline");
    const fold = await read(
      "(()=>{const r=document.querySelector('.cm-foldGutter [title=\"Fold line\"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()",
    );
    win.webContents.sendInputEvent({ type: "mouseMove", ...fold });
    win.webContents.sendInputEvent({ type: "mouseDown", ...fold, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", ...fold, button: "left", clickCount: 1 });
    await waitFor("!!document.querySelector('.cm-foldPlaceholder')", "fold function");
    await read("document.querySelector('.cm-content').focus()");
    await key("F10", ["shift"]);
    await waitFor("Array.from(document.querySelectorAll('[role=menuitem]')).some(e=>e.textContent==='Outline')", "keyboard context menu");
    await key("Escape");
    await open("math.ts", "double", 2);
    await read("document.querySelector('.cm-content').focus()");
    await key("a", modifiers);
    win.webContents.insertText("/** Accept a name. */\nexport function double(value: string): string {\n  return value + value;\n}\n");
    await waitFor("window.editorQA.snapshot().dirty.some(d=>d.text?.includes('value: string'))", "unsaved dependency");
    await open("main.ts", "double(2)", 7);
    await waitFor("document.querySelector('.file-problems-status')?.textContent==='2 problems'", "unsaved dependency diagnostics");
    await button("Problems, 2");
    assert.match(await read("document.querySelector('[aria-label=Problems]').textContent"), /string/);
    await shot("problems-light");
    const unchanged = await read("fetch('/disk').then(r=>r.json())");
    assert.match(unchanged.math, /value: number/, "unsaved dependency leaves disk untouched");
    await button("Close problems");
    await waitFor("document.querySelector('.cm-editor-information')?.textContent.includes('Accept a name.')", "unsaved parameter documentation");
    for (const theme of ["dark", "light"]) {
      await read(`window.editorQA.theme(${JSON.stringify(theme)})`);
      for (const width of [1000, 420]) {
        win.setSize(width, 780);
        await pause(250);
        assert.equal(await read("document.documentElement.scrollWidth<=innerWidth"), true, "responsive document");
        assert.equal(
          await read(
            "Array.from(document.querySelectorAll('.cm-tooltip')).every(t=>{const r=t.getBoundingClientRect(),e=document.querySelector('.cm-editor').getBoundingClientRect();return r.top<0 || (r.left>=e.left-1 && r.right<=e.right+1)})",
          ),
          true,
          "tooltips stay inside the editor",
        );
        await shot(`${theme}-${width}`);
      }
    }
    await read("window.editorQA.palette('claude')");
    assert.equal(await read("document.documentElement.dataset.palette"), "claude");
    await shot("claude-420");
    assert.deepEqual(errors, [], "renderer errors");
    console.log("Editor Chromium smoke passed:", dir);
  } catch (error) {
    await shot("failure");
    console.error("Editor UI state:", await read("document.body.innerText"));
    console.error("Draft state:", await read("window.editorQA.snapshot()"));
    console.error("Renderer errors:", errors, "Artifacts:", dir);
    throw error;
  } finally {
    win.destroy();
    app.quit();
  }
}

(process.versions.electron ? check() : launch()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
  if (process.versions.electron) require("electron").app.exit(1);
});
