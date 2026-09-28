/** Disposable Electron smoke of the real text-generation settings component. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  if (!process.versions.electron) {
    const dir = await fs.mkdtemp("/tmp/openorc-text-settings-");
    await require("./build-transcript-fixture.cjs")(dir, "text-generation-settings-ui.tsx");
    const env = { ...process.env, OPENORC_TEXT_SMOKE: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_TEXT_SMOKE;
  app.setPath("userData", path.join(dir, "profile"));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const read = (code) => win.webContents.executeJavaScript(code);
  const until = async (code) => {
    for (let i = 0; i < 80; i++) {
      if (await read(code)) return;
      await pause(100);
    }
    await fs.writeFile(path.join(dir, "failure.png"), (await win.webContents.capturePage()).toPNG());
    throw new Error(`Timed out: ${code}\nScreenshot: ${path.join(dir, "failure.png")}\n${await read("document.body.innerText")}`);
  };
  const field = (label) => `Array.from(document.querySelectorAll('label')).find(e=>e.querySelector('.font-medium')?.textContent===${JSON.stringify(label)})?.querySelector('select')`;
  const fill = (label, value) => read(`(()=>{const e=${field(label)};e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const saved = () => until("document.querySelector('.settings-feedback')?.textContent==='Saved'");
  const picker = `document.querySelector('button[aria-label="Text generation model"]')`;
  const search = `document.querySelector('input[aria-label="Search models"]')`;
  const modelRow = (text) => `Array.from(document.querySelectorAll('.model-picker-row')).find(e=>e.textContent===${JSON.stringify(text)})`;
  const provider = (name) => `document.querySelector('.model-picker-rail-button[aria-label^=${JSON.stringify(name)}]')`;
  const click = async (selector) => {
    await until(`Boolean(${selector})`);
    const rect = await read(`(()=>{const r=(${selector}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: "mouseMove", ...rect });
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...rect });
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...rect });
    await pause(100);
  };
  const searchFor = async (query) => {
    await until(`Boolean(${search})`);
    await read(
      `(()=>{const e=${search};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(query)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  };
  const openPicker = async () => {
    await click(picker);
    await until(`Boolean(${search})`);
  };
  const closePicker = async () => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "ESC" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "ESC" });
    await until(`!(${search})`);
  };
  const choose = async (query, text) => {
    await openPicker();
    await searchFor(query);
    await click(modelRow(text));
    await saved();
    await until(`!(${search})`);
  };
  const preferences = `JSON.parse(localStorage.getItem('text-preferences'))`;
  const captures = [];
  try {
    await win.loadFile(path.join(dir, "index.html"));
    await until(`${field("Harness")} && !${field("Harness")}.disabled`);
    assert.equal(await read(`${field("Harness")}.value`), "auto");
    assert.equal(await read(`Boolean(${picker})`), false);
    await fill("Harness", "codex");
    await saved();
    await until(`${picker} && !${picker}.disabled`);
    assert.equal(await read(`${picker}.textContent`), "Low-cost default");
    await choose("GPT Mini", "GPT Mini");
    assert.equal(await read(`${preferences}.models.codex`), "gpt-mini");
    await win.loadFile(path.join(dir, "index.html"));
    await until(`${picker}?.textContent==='GPT Mini'`);
    await read("textSmoke.fail()");
    await fill("Harness", "claude");
    await until("document.body.textContent.includes('Could not save')");
    assert.equal(await read(`${field("Harness")}.value`), "claude", "Keeps unsaved choice");
    assert.equal(await read(`${picker}.disabled`), true, "Cannot save a model against an unsaved provider");
    await read("Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Retry save').click()");
    await saved();
    await fill("Harness", "codex");
    await saved();
    assert.equal(await read(`${picker}.textContent`), "GPT Mini", "Keeps model per provider");

    // Switch providers in the same panel; a cross-harness choice saves its full ID atomically.
    await openPicker();
    await click(provider("OpenCode"));
    await searchFor("GPT Mini");
    await until(`Boolean(${modelRow("GPT MiniOpenRouter")})`);
    assert(await read(`Boolean(${modelRow("GPT MiniOpenCode")})`), "Same model name identifies its billing provider");
    await searchFor("OpenRouter");
    assert.equal(await read(`${modelRow("Blocked modelOpenRouterRequires a newer CLI.")}?.disabled`), true);
    assert.equal(await read("document.body.textContent.includes('Reset effort to model default') || Boolean(document.querySelector('[aria-label=\"Fast mode\"]'))"), false);
    await read("textSmoke.fail()");
    await click(modelRow("GPT MiniOpenRouter"));
    await until("document.body.textContent.includes('Could not save')");
    assert.equal(await read(`${field("Harness")}.value`), "opencode");
    assert.equal(await read(`${picker}.disabled`), true);
    await read("Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Retry save').click()");
    await saved();
    assert.equal(await read(`${preferences}.provider`), "opencode");
    assert.equal(await read(`${preferences}.models.opencode`), "openrouter/openai/gpt-5-mini");
    await win.loadFile(path.join(dir, "index.html"));
    await until(`${picker}?.textContent==='GPT Mini'`);
    assert.equal(await read(`${field("Harness")}.value`), "opencode");

    // Inspect provider groups and search in both themes at desktop and narrow widths.
    for (const [theme, width] of [
      ["light", 1280],
      ["dark", 900],
    ]) {
      win.setSize(width, 860);
      await read(`textSmoke.theme(${JSON.stringify(theme)})`);
      await openPicker();
      await until(`!document.body.textContent.includes('Refreshing models')`);
      await click(provider("OpenCode"));
      await until("Array.from(document.querySelectorAll('.model-picker-group')).some(e=>e.textContent.includes('OpenRouter') && e.textContent.includes('Gemini Flash Lite'))");
      await pause(200);
      const file = path.resolve(__dirname, `../output/qa/text-generation/settings-${theme}-${width}.png`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, (await win.webContents.capturePage()).toPNG());
      captures.push(file);
      assert(
        await read("document.documentElement.scrollWidth<=innerWidth && document.querySelector('.settings-content').scrollWidth<=document.querySelector('.settings-content').clientWidth"),
        "No horizontal overflow",
      );
      // Close the single panel without selecting anything.
      await click(picker);
      await until(`!(${search})`);
    }

    const loads = await read("textSmoke.calls.filter(m=>m==='agents.modelCatalog').length");
    await read("textSmoke.catalogFailure(true)");
    await openPicker();
    await until("document.body.textContent.includes('Could not refresh models')");
    assert((await read("textSmoke.calls.filter(m=>m==='agents.modelCatalog').length")) > loads, "Opening refreshes the catalog");
    await click(provider("OpenCode"));
    await searchFor("OpenRouter");
    assert(await read(`Boolean(${modelRow("GPT MiniOpenRouter")})`), "Cached choices survive failed refresh");
    await read("textSmoke.catalogFailure(false)");
    await click(`document.querySelector('.model-picker-text-action')`);
    await until("!document.body.textContent.includes('Could not refresh models') && !document.body.textContent.includes('Refreshing models')");
    assert.equal(await read(`${search}.value`), "OpenRouter", "Retry keeps search open");
    await closePicker();

    // A stored model remains visible even if the current catalog stops listing it.
    await read("textSmoke.omit('openrouter/openai/gpt-5-mini')");
    await openPicker();
    await until(`${picker}?.textContent==='openrouter/openai/gpt-5-mini'`);
    await closePicker();
    assert.equal(await read(`${preferences}.models.opencode`), "openrouter/openai/gpt-5-mini");
    await read("Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Use low-cost default').click()");
    await saved();
    assert.equal(await read(`${preferences}.models.opencode`), null);
    assert.equal(await read(`${picker}.textContent`), "Low-cost default");
    assert(await read("document.body.textContent.includes('Using Gemini Flash Lite through OpenCode')"));
    await fill("Harness", "codex");
    await saved();
    assert.equal(await read(`${picker}.textContent`), "GPT Mini", "Reset affects only the selected harness");
    await fill("Harness", "auto");
    await saved();
    assert.equal(await read(`Boolean(${picker})`), false);
    await fill("Harness", "opencode");
    await saved();
    await read("textSmoke.unavailable()");
    await until("document.body.textContent.includes('OpenCode is unavailable')");
    assert(await read("document.body.textContent.includes('Thread titles will use the opening message')"));
    await openPicker();
    await until(`${provider("OpenCode")}?.getAttribute('aria-label').includes('Sign in')`);
    await click(provider("OpenCode"));
    assert.equal(
      await read("(()=>{const rows=[...document.querySelectorAll('.model-picker-row')].filter(row=>row.textContent.includes('GPT Mini'));return rows.length>0&&rows.every(row=>row.disabled)})()"),
      true,
    );
    await closePicker();
    await fill("Harness", "off");
    await saved();
    assert.equal(await read(`Boolean(${picker})`), false);
    assert(await read("document.body.textContent.includes('Thread titles use the opening message.')"));
    assert.equal(await read("textSmoke.calls.some(method=>method.startsWith('memory.'))"), false);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify(
        {
          passed: true,
          captures,
          checks:
            "provider-scoped search/groups, duplicate labels, unavailable model/harness, cross-harness save/retry, reload, per-harness reset, automatic/off, refresh/retry, missing catalog selection, light/dark, no memory calls",
        },
        null,
        2,
      ),
    );
  } finally {
    win.destroy();
    app.quit();
  }
}
main().catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
