/** Real Chromium checks for the two readability views with synthetic RPC data only. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildAndRun() {
  const dir = await fs.mkdtemp("/tmp/openorc-readability-views-");
  await require("./build-transcript-fixture.cjs")(dir, "orchestration-scheduled-ui.tsx");
  const env = { ...process.env, OPENORC_READABILITY_VIEWS_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => (process.exitCode = code ?? 1));
}

async function checkUI() {
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_READABILITY_VIEWS_DIR;
  app.setPath("userData", path.join(dir, "profile"));
  setTimeout(() => app.exit(1), 60000).unref();
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1080, height: 800, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const read = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, label) => {
    for (let n = 0; n < 120; n++) {
      if (await read(`Boolean(${code})`)) return;
      await pause(50);
    }
    throw new Error(`Timed out: ${label}\n${errors.join("\n")}`);
  };
  const shot = async (name) => fs.writeFile(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const setInput = (selector, value) =>
    read(
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
  const clickText = (name) => read(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(name)}).click()`);
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    if (keyCode === "Enter") win.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await pause(80);
  };
  const layout = async (name) => {
    const result = await read(
      `({ overflow: document.documentElement.scrollWidth > innerWidth, heading: Boolean(document.querySelector('h1, .schedule-row')), controls: [...document.querySelectorAll('input, select, button')].filter(el => { const box = el.getBoundingClientRect(); return box.width && box.height && (box.left < -1 || box.right > innerWidth + 1); }).length })`,
    );
    assert.deepEqual(result, { overflow: false, heading: true, controls: 0 }, name);
    await shot(name);
  };
  try {
    await win.loadFile(path.join(dir, "index.html"));
    await until(`document.querySelector('input[aria-label="Team name"]')`, "team editor");
    await layout("team-light");
    await setInput('input[aria-label="Team name"]', "Keyboard review team");
    await until(`document.body.innerText.includes('Unsaved changes')`, "team draft");
    await key("S", ["meta"]);
    await until(`readabilityViews.calls.some(call => call.method === 'orchestration.save')`, "team keyboard save");
    await until(`document.querySelector('input[aria-label="Team name"]')?.value === 'Keyboard review team' && document.body.innerText.includes('Version 2')`, "team saved revision");
    await clickText("Choose default");
    await until(`document.querySelector('[role="radiogroup"] button')`, "avatar choices");
    await read(`document.querySelectorAll('[role="radiogroup"] button')[1].click()`);
    await until(`readabilityViews.calls.some(call => call.method === 'orchestration.avatars.set')`, "member avatar update");
    win.setSize(620, 700);
    await read(`readabilityViews.theme('dark')`);
    await pause(180);
    await layout("team-dark-narrow");

    await read(`readabilityViews.show('scheduled')`);
    await until(`document.body.innerText.includes('Daily review')`, "schedule list");
    await read(`readabilityViews.theme('light')`);
    win.setSize(1080, 800);
    await layout("schedule-light");
    await read(`document.querySelector('.schedule-row > .flex > button').click()`);
    await until(`document.querySelector('input[placeholder="Nightly dependency check"]')`, "schedule editor");
    await setInput('input[placeholder="Nightly dependency check"]', "Keyboard daily review");
    await read(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Save').focus()`);
    await key("Enter");
    await until(`readabilityViews.calls.some(call => call.method === 'schedules.update')`, "schedule keyboard save");
    await until(`!document.querySelector('input[placeholder="Nightly dependency check"]') && document.body.innerText.includes('Keyboard daily review')`, "schedule saved");
    win.setSize(620, 700);
    await read(`readabilityViews.theme('dark')`);
    await pause(180);
    await layout("schedule-dark-narrow");
    await read(`document.querySelector('.schedule-row > .flex > button').click()`);
    await until(`document.querySelector('input[placeholder="Nightly dependency check"]')`, "narrow schedule editor");
    await layout("schedule-dialog-dark-narrow");
    assert.deepEqual(errors, []);
    console.log("Orchestration/Scheduled UI smoke passed; screenshots:", dir);
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(
      await read(
        `({ dialog: document.querySelector('[role="dialog"]')?.innerText, saveDisabled: [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Save')?.disabled, active: document.activeElement?.outerHTML, calls: readabilityViews.calls.slice(-5) })`,
      ).catch(() => null),
    );
    console.error(errors);
    app.exit(1);
  }
}

if (process.versions.electron) void checkUI();
else void buildAndRun();
