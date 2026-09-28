/** Real production composer keyboard/click coverage; no live provider or user database. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function buildAndRun() {
  const dir = await fs.mkdtemp("/tmp/openorc-composer-steering-");
  await require("./build-transcript-fixture.cjs")(dir, "composer-steering-ui.tsx");
  const env = { ...process.env, OPENORC_STEERING_UI_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
async function checkUI() {
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_STEERING_UI_DIR;
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const read = (code) => win.webContents.executeJavaScript(code);
  const until = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (await read(`Boolean(${code})`)) return;
      await pause(50);
    }
    throw Error(`Timed out: ${code}\n${errors.join("\n")}`);
  };
  const text = async (value) => {
    await read(
      `(() => { const el=document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.focus(); })()`,
    );
  };
  const enter = (modifiers) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return", modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return", modifiers });
  };
  const options = async (opts) => {
    await read(`composerSmoke.options(${JSON.stringify(opts)})`);
    await pause(50);
  };
  const sent = async (count, now) => {
    await until(`composerSmoke.sent().length === ${count}`);
    assert.equal(await read(`composerSmoke.sent().at(-1).now`), now);
  };
  try {
    await win.loadFile(path.join(dir, "index.html"));
    await until(`document.querySelector('textarea')`);
    assert.equal(await read(`document.querySelector('.composer-send').getAttribute('aria-label')`), "Stop");
    assert.equal(await read(`document.querySelector('[aria-label="Send"]')`), null);
    await read(`document.querySelector('[aria-label="Stop"]').click()`);
    assert.equal(await read(`composerSmoke.stopCalls()`), 1);
    await text("Change the avatar");
    enter([]);
    await sent(1, true);
    await text("Keep for later");
    await read(`[...document.querySelectorAll('button')].find(el=>el.textContent==='Queue').click()`);
    await sent(2, false);
    await text("A second live correction");
    await read(`document.querySelector('[aria-label="Send"]').click()`);
    await sent(3, true);
    await options({ liveByDefault: true, queueing: true, steerable: false });
    await text("Keep live intent through compaction");
    enter([]);
    await sent(4, true);
    // Newlines and IME composition must not submit.
    await text("Draft");
    enter(["shift"]);
    await pause(80);
    await read(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true}))`);
    assert.equal(await read(`composerSmoke.sent().length`), 4);
    await options({ liveByDefault: true, queueing: false, steerable: false });
    assert.equal(await read(`[...document.querySelectorAll('button')].some(el=>el.textContent==='Queue')`), false);
    await text("Idle send");
    enter([]);
    await sent(5, false);
    await options({ liveByDefault: false, queueing: true, steerable: true });
    await text("Solo queues");
    enter([]);
    await sent(6, false);
    await text("Solo steers");
    enter([process.platform === "darwin" ? "meta" : "control"]);
    await sent(7, true);
    // A failed send keeps the draft and attachment, and retry hands over both.
    await options({ liveByDefault: true, queueing: true, steerable: true });
    await text("Read the correction image");
    await read(
      `(() => { const data=new DataTransfer(); data.items.add(new File(['image'],'revision.png',{type:'image/png'})); document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data})); })()`,
    );
    await until(`document.querySelector('[aria-label="Remove image"]')`);
    await text("");
    assert.equal(await read(`document.querySelector('.composer-send').getAttribute('aria-label')`), "Send");
    assert.equal(await read(`document.querySelector('[aria-label="Send"]').disabled`), false);
    await text("Read the correction image");
    await read(`composerSmoke.failNext()`);
    enter([]);
    await until(`document.body.textContent.includes('Delivery could not be saved')`);
    assert.equal(await read(`document.querySelector('textarea').value`), "Read the correction image");
    assert.equal(await read(`document.querySelector('[aria-label="Remove image"]') !== null`), true);
    enter([]);
    await sent(8, true);
    assert.equal(await read(`composerSmoke.sent().at(-1).attachments.length`), 1);
    // Reopening the same draft must retain its in-flight send rather than admit another one.
    await text("A pending correction");
    await read(`composerSmoke.holdNext()`);
    enter([]);
    await until(`document.body.textContent.includes('Sending…')`);
    for (let i = 0; i < 6; i++) {
      await read(`composerSmoke.showComposer(false)`);
      await until(`!document.querySelector('textarea')`);
      await read(`composerSmoke.showComposer(true)`);
      await until(`document.querySelector('textarea')`);
      assert.equal(await read(`document.querySelector('textarea').disabled`), true);
      assert.equal(await read(`document.querySelector('[aria-label="Send"]').disabled`), true);
      await read(`document.querySelector('[aria-label="Send"]').click()`);
      enter([]);
      assert.equal(await read(`composerSmoke.sent().length`), 8);
    }
    for (const theme of ["light", "dark"]) {
      await read(`composerSmoke.theme('${theme}')`);
      for (const width of [900, 380]) {
        win.setSize(width, 600);
        await pause(150);
        assert.equal(await read(`document.querySelector('[aria-label="Send"]').getBoundingClientRect().right <= innerWidth`), true);
        await fs.writeFile(path.join(dir, `${theme}-${width}-sending.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    await read(`composerSmoke.releaseSend()`);
    await sent(9, true);
    await until(`document.querySelector('textarea').value === '' && !document.body.textContent.includes('Sending…')`);
    // Exercise the production RPC path: pending acknowledgment, visible failure, and retry.
    await read(`composerSmoke.nativeStop(true)`);
    await pause(50);
    await read(`document.querySelector('[aria-label="Stop"]').click()`);
    await until(`document.querySelector('[aria-label="Stop"]').disabled && document.body.textContent.includes('Stopping…')`);
    await read(`document.querySelector('[aria-label="Stop"]').click()`);
    assert.equal(await read(`composerSmoke.stopCalls()`), 2);
    for (const theme of ["light", "dark"]) {
      await read(`composerSmoke.theme('${theme}')`);
      await pause(150);
      await fs.writeFile(path.join(dir, `${theme}-380-stopping.png`), (await win.webContents.capturePage()).toPNG());
    }
    await read(`composerSmoke.rejectStop()`);
    await until(`document.querySelector('[role="alert"]')?.textContent.includes('Provider refused cancellation')`);
    assert.equal(await read(`document.querySelector('[aria-label="Stop"]').disabled`), false);
    await text("Preserve this draft while stopping");
    await read(`document.querySelector('[aria-label="Stop"]').click()`);
    await until(`document.querySelector('[aria-label="Stop"]').disabled && composerSmoke.stopCalls() === 3`);
    await read(`composerSmoke.acceptStop()`);
    await until(`!document.body.textContent.includes('Stopping…') && !document.querySelector('[role="alert"]')`);
    assert.equal(await read(`document.querySelector('textarea').value`), "Preserve this draft while stopping");
    await read(`composerSmoke.nativeStop(false)`);
    await text("Use a square avatar and keep the other work running.");
    for (const theme of ["light", "dark"]) {
      await read(`composerSmoke.theme('${theme}')`);
      for (const width of [900, 520, 380]) {
        win.setSize(width, 600);
        await pause(150);
        assert.equal(await read(`document.querySelector('[aria-label="Send"]').getBoundingClientRect().right <= innerWidth`), true);
        await fs.writeFile(path.join(dir, `${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG());
        await read(`document.querySelector('[aria-label="Context usage"]').click()`);
        await until(`document.querySelector('[role="dialog"]')`);
        await pause(100);
        assert.equal(await read(`composerSmoke.compactCalls()`), 0);
        assert.equal(
          await read(
            `(() => {const el=document.querySelector('[role="dialog"]'), r=el.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && el.scrollWidth<=el.clientWidth;})()`,
          ),
          true,
        );
        assert.equal(await read(`document.querySelector('[role="dialog"]').textContent.includes('610,000 tokens')`), true);
        await fs.writeFile(path.join(dir, `${theme}-${width}-context.png`), (await win.webContents.capturePage()).toPNG());
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await until(`!document.querySelector('[role="dialog"]')`);
        assert.equal(await read(`document.activeElement.getAttribute('aria-label')`), "Context usage");
        await text("");
        await until(`document.querySelector('.composer-send[aria-label="Stop"]')`);
        await fs.writeFile(path.join(dir, `${theme}-${width}-stop.png`), (await win.webContents.capturePage()).toPNG());
        await text("Use a square avatar and keep the other work running.");
        await until(`document.querySelector('.composer-send[aria-label="Send"]')`);
      }
    }
    await read(`composerSmoke.canCompact(false); composerSmoke.context({used:12345,window:null})`);
    await pause(50);
    await read(`document.querySelector('[aria-label="Context usage"]').click()`);
    await until(`document.querySelector('[role="dialog"]')`);
    assert.equal(await read(`document.querySelector('[role="dialog"]').textContent.includes('Not reported')`), true);
    assert.equal(await read(`document.querySelector('[role="dialog"] button').disabled`), true);
    await read(`composerSmoke.canCompact(true)`);
    await pause(50);
    await read(`document.querySelector('[role="dialog"] button').click()`);
    await until(`composerSmoke.compactCalls() === 1`);
    await until(`document.querySelector('[role="dialog"] button').disabled`);
    await read(`document.querySelector('[role="dialog"] button').click()`);
    assert.equal(await read(`composerSmoke.compactCalls()`), 1);
    assert.deepEqual(errors, []);
    console.log(
      "Composer UI smoke passed: context popover, explicit compaction, unavailable context, Escape/focus, empty-draft Stop, Stop pending/error/retry, attachment-only Send, queue/steer, IME, retry, pending send/navigation, and both themes at three widths. Screenshots:",
      dir,
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}
if (process.versions.electron) void checkUI();
else void buildAndRun();
