/** Real task/review renderer flows with synthetic RPCs and an isolated Electron profile. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!process.versions.electron) {
    const dir = await fs.mkdtemp("/tmp/openorc-readability-task-");
    await require("./build-transcript-fixture.cjs")(dir, "readability-task-ui.tsx");
    const env = { ...process.env, OPENORC_TASK_READABILITY_FIXTURE: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_TASK_READABILITY_FIXTURE;
  app.setPath("userData", path.join(dir, "profile"));
  setTimeout(() => app.exit(1), 60000).unref();
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1050, height: 900, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const read = (code) => win.webContents.executeJavaScript(code);
  const until = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (await read(code)) return;
      await pause(50);
    }
    throw new Error(`Timed out: ${code}\n${errors.join("\n")}`);
  };
  const button = (name) => `[...document.querySelectorAll('button')].find(b => b.getClientRects().length && b.textContent.trim() === ${JSON.stringify(name)})`;
  const click = async (name) => {
    await until(`Boolean(${button(name)})`);
    await read(`${button(name)}.click()`);
  };
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await pause(60);
  };
  const type = async (selector, value) => {
    await read(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.focus(); element.select(); })()`);
    await win.webContents.insertText(value);
  };
  try {
    await win.loadFile(path.join(dir, "index.html"));
    await until(`Boolean(document.querySelector('.task-rich-editor'))`);
    await read("taskSmoke.failSave(true)");
    await type('[aria-label="Task title"]', "Recovered task title");
    await key("s", ["control"]);
    await until(`document.querySelector('.document-footer').textContent.includes('Couldn’t save')`);
    assert.match(await read(`localStorage.getItem('openorc.draft.task.task')`), /Recovered task title/);
    await read("taskSmoke.view('review')");
    await until(`Boolean(document.querySelector('[aria-label^="Select comment"]'))`);
    await read("taskSmoke.view('document')");
    await until(`document.querySelector('[aria-label="Task title"]')?.value === 'Recovered task title'`);
    await read("taskSmoke.failSave(false)");
    await key("s", ["control"]);
    // The remount may move focus; the public save barrier is also used by navigation.
    assert.equal(await read("taskSmoke.flush()"), true);
    await until(`document.querySelector('.document-footer').textContent.includes('Saved')`);
    assert.equal(await read(`localStorage.getItem('openorc.draft.task.task')`), null);
    await type('[aria-label="Task comment"]', "A plain task note");
    await key("Enter", ["control"]);
    await until(`taskSmoke.calls.some(c => c.method === 'tasks.comments.post')`);
    await until(`document.querySelector('[aria-label="Task comment"]').value === ''`);
    assert.equal(await read(`taskSmoke.calls.find(c => c.method === 'tasks.comments.post').params.body`), "A plain task note");
    for (const view of ["document", "review"]) {
      await read(`taskSmoke.view(${JSON.stringify(view)})`);
      const ready = view === "document" ? `Boolean(document.querySelector('.task-rich-editor'))` : `Boolean(document.querySelector('[aria-label^="Select comment"]'))`;
      await until(ready);
      for (const [theme, width] of [
        ["light", 1050],
        ["dark", 480],
      ]) {
        win.setSize(width, 900);
        await read(`taskSmoke.theme(${JSON.stringify(theme)})`);
        await pause(180);
        assert.equal(await read("document.documentElement.scrollWidth <= innerWidth"), true, `${view} ${width} horizontal overflow`);
        await fs.writeFile(path.join(dir, `${view}-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    await read(`document.querySelector('[aria-label^="Select comment"]').click()`);
    await click("Commit");
    await until(`document.activeElement?.tagName === 'TEXTAREA'`);
    await win.webContents.insertText("Preserve this commit message");
    await read(`([...document.querySelectorAll('[role="dialog"] button')].find(b=>b.textContent.trim()==='Commit')).click()`);
    await until(`document.querySelector('[role="dialog"]').textContent.includes('Fixture commit unavailable')`);
    await key("Escape");
    await until(`!document.querySelector('[role="dialog"]')`);
    assert.equal(await read(`document.querySelector('[aria-label^="Select comment"]').checked`), true);
    await key("Tab");
    assert.equal(await read(`document.activeElement !== document.body`), true);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        ok: true,
        dir,
        checks: [
          "keyboard save",
          "failed-save recovery",
          "navigation draft retention",
          "task comment keyboard submit",
          "light/dark narrow layout",
          "commit error retains selection",
          "dialog keyboard focus",
        ],
      }),
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
