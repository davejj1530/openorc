/**
 * The two panel panes against the built app: a real shell in the thread's
 * worktree, and a real page served on loopback.
 *
 * Needs a disposable qa-seed fixture, the way the orchestration smokes do:
 *   FIX=$(node --import tsx scripts/qa-seed.ts | tail -1)
 *   OPENORC_QA_FIXTURE=$FIX pnpm --filter @openorc/desktop exec electron "$PWD/scripts/panes-ui-smoke.cjs"
 *
 * No provider is started and no model is called. The shell runs `echo`, and
 * the page comes from a throwaway http server in this process.
 */
const { app } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const fixture = JSON.parse(fs.readFileSync(process.env.OPENORC_QA_FIXTURE ?? "", "utf8"));
if (!path.basename(fixture.dir).startsWith("openorc-workflow-qa-")) throw Error("A disposable qa-seed fixture is required.");
process.env.OPENORC_USER_DATA = fixture.data;
process.env.OPENORC_ROUTE = "newthread";
process.env.OPENORC_THEME = "dark";
for (const key of Object.keys(process.env)) if (key.startsWith("OPENORC_AUTORUN_") || key === "OPENORC_AUTOBENCH" || key === "OPENORC_AUTODIFF") delete process.env[key];
delete process.env.ELECTRON_RENDERER_URL;

const db = new DatabaseSync(path.join(fixture.data, "openorc.sqlite"), { readOnly: true });
const title = db.prepare("SELECT title FROM threads ORDER BY created_at LIMIT 1").get().title;
const captures = path.join(fixture.dir, "panes-captures");
fs.mkdirSync(captures, { recursive: true });
const PORT = 41730;
const MARKER = "OPENORC_PREVIEW_SERVED";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Long enough for a cold start plus a login shell probe, short enough to fail a hang.
setTimeout(() => {
  console.error("panes smoke timed out");
  process.exit(1);
}, 120_000);

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(`<!doctype html><title>dev server</title><body>${MARKER}`);
});

require("node:module").createRequire(__filename);
import(path.join(__dirname, "../apps/desktop/out/main/index.mjs"));

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  await pause(4500);
  const { BrowserWindow, session, webContents } = require("electron");
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1500, 900);
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message.slice(0, 200));
  });
  const read = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, label, tries = 150) => {
    for (let i = 0; i < tries; i++) {
      if (await read(`Boolean(${code})`)) return;
      await pause(150);
    }
    throw Error(`Timed out: ${label}\n${errors.join("\n")}`);
  };
  const clickText = (label) =>
    read(
      `(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return x.textContent.trim()===${JSON.stringify(label)};})[0]; if(!b){throw new Error('no button '+${JSON.stringify(label)});} b.click(); })()`,
    );
  // Terminal and Preview join the tab strip from the add menu the first time a thread opens them.
  const openTool = async (label) => {
    // A keyboard-style activation: the trigger opens its menu on click, with no pointer to track.
    await until(`document.querySelector('[aria-label="Open a tool"]')`, "the add menu");
    await read(`document.querySelector('[aria-label="Open a tool"]').click()`);
    const item = `[].slice.call(document.querySelectorAll('[role="menuitem"]')).filter(function(m){return m.textContent.trim()===${JSON.stringify(label)};})[0]`;
    await until(item, `${label} in the add menu`);
    await read(`${item}.click()`);
  };
  const shot = async (name) => fs.writeFileSync(path.join(captures, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const guestFor = async (needle) => {
    for (let i = 0; i < 90; i++) {
      const found = webContents.getAllWebContents().find((c) => c.getURL().includes(needle));
      if (found) return found;
      await pause(200);
    }
    return null;
  };

  try {
    const selector = `button[title=${JSON.stringify(title)}]`;
    await until(`document.querySelector(${JSON.stringify(selector)})`, "thread in the sidebar");
    await read(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await until(`document.querySelector('[aria-label="Show panel"]') || document.querySelector('[aria-label="Hide panel"]')`, "panel toggle");
    if (await read(`Boolean(document.querySelector('[aria-label="Show panel"]'))`)) await read(`document.querySelector('[aria-label="Show panel"]').click()`);

    // The shell runs where the diff is read from, and keystrokes reach it.
    await openTool("Terminal");
    await until(`document.querySelector('.xterm-screen')`, "xterm mounted");
    // Not a fixed wait: the shell is a login shell and how long it takes to
    // print a prompt depends on the user's rc files. Typing before then drops
    // the keystrokes on the floor with nothing to show for it.
    await until(`document.querySelector('.xterm-rows').textContent.trim().length > 0`, "the shell printed a prompt", 300);
    await pause(250);
    await read(`document.querySelector('.xterm-helper-textarea').focus()`);
    for (const character of `echo ${MARKER}`) win.webContents.sendInputEvent({ type: "char", keyCode: character });
    win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    await until(`document.querySelector('.xterm-rows').textContent.indexOf(${JSON.stringify(MARKER)}) !== -1`, "the shell echoed the command");
    await shot("terminal");

    // A shell outlives the panel that shows it: leaving the tab must not end it.
    // The seeded thread owns tasks, so its Tasks tab is in the strip. By its tab, not its text:
    // the sidebar has a Tasks button too.
    const clickTab = (label) => read(`document.querySelector('.panel-tabs [aria-label=${JSON.stringify(label)}]').click()`);
    await clickTab("Tasks");
    await pause(600);
    await clickTab("Terminal");
    await until(`document.querySelector('.xterm-rows').textContent.indexOf(${JSON.stringify(MARKER)}) !== -1`, "scrollback replayed on re-attach");

    // The preview loads a real loopback page, on a session of its own.
    await openTool("Preview");
    await until(`document.querySelector('.panel-pane input')`, "address field");
    const type = (value) =>
      read(
        `(function(){ var i=document.querySelector('.panel-pane input'); var set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i,${JSON.stringify(value)}); i.dispatchEvent(new Event('input',{bubbles:true})); var f=i.form; if(f){f.requestSubmit();} })()`,
      );
    await type(`http://127.0.0.1:${PORT}`);
    const guest = await guestFor(String(PORT));
    assert.ok(guest, "the pane never created a WebContents for the dev server");
    await pause(1200);
    assert.match(await guest.executeJavaScript("document.body.innerText"), new RegExp(MARKER));
    assert.notEqual(guest.session, session.defaultSession, "the pane must not share the default session, which also serves openorc-asset://");

    // The view is composited above the page, so its placement is only checkable from main.
    const placed = win.contentView.children.filter((view) => view.getBounds().width > 0).map((view) => view.getBounds());
    const pane = await read(`(function(){ var r=document.querySelector('.panel-pane').getBoundingClientRect(); return {x:Math.round(r.x),width:Math.round(r.width)}; })()`);
    assert.equal(placed.length, 1, `expected one attached view, saw ${placed.length}`);
    assert.equal(placed[0].x, pane.x);
    assert.equal(placed[0].width, pane.width);

    // Expanded, the preview takes the whole work row and the native view follows it. Collapsing
    // puts both back at the panel's width.
    const attached = () => win.contentView.children.filter((view) => view.getBounds().width > 0).map((view) => view.getBounds());
    await read(`document.querySelector('button[aria-label="Expand panel"]').click()`);
    await until(`document.querySelector('.panel-shell[data-expanded="true"]')`, "expanded preview");
    await pause(600);
    const row = await read(`(function(){ var r=document.querySelector('.work-row').getBoundingClientRect(); return {x:Math.round(r.x),width:Math.round(r.width)}; })()`);
    const wide = attached();
    assert.equal(wide.length, 1, `expected one attached view while expanded, saw ${wide.length}`);
    assert.equal(wide[0].x, row.x);
    assert.equal(wide[0].width, row.width);
    await shot("preview-expanded");
    await read(`document.querySelector('button[aria-label="Collapse panel"]').click()`);
    await until(`!document.querySelector('.panel-shell[data-expanded="true"]')`, "collapsed preview");
    await pause(600);
    assert.equal(attached()[0].width, pane.width);

    // The single model panel must stay inside the conversation pane; the
    // native preview would cover any portion beyond its left edge.
    await read(`document.querySelector('button[aria-label="Model and effort"]').click()`);
    await until(`document.querySelector('.model-picker-popup')`, "model picker");
    const popup = await read(`(function(){ var r=document.querySelector('.model-picker-popup').getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; })()`);
    assert.ok(popup.left >= 8 && popup.right <= pane.x - 8, `model picker enters the native preview: ${JSON.stringify({ popup, pane })}`);
    assert.equal(await read(`document.querySelectorAll('.menu-popup').length`), 0, "model selection opened a nested menu");
    assert.equal(await read(`getComputedStyle(document.querySelector('.model-picker-results')).overflowY`), "auto");
    assert.equal(await read(`document.activeElement === document.querySelector('input[aria-label="Search models"]')`), false, "opening the picker focused search");
    await shot("model-picker-preview");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });

    // Public HTTP(S) is allowed; embedded credentials must still be refused.
    await type("https://user:pass@example.com");
    await pause(1500);
    assert.ok(
      webContents.getAllWebContents().every((c) => !c.getURL().includes("user:pass")),
      "an address with embedded credentials was allowed to load",
    );
    assert.match(await read(`document.querySelector('.panel-pane').innerText`), /embedded credentials/);
    await shot("preview-refused");

    assert.deepEqual(errors, []);
    console.log("panes UI smoke passed; screenshots in", captures);
    app.exit(0);
  } catch (error) {
    console.error(error);
    await shot("failure");
    app.exit(1);
  }
});
