/** Production composer + changes panel, isolated from user data and real Git mutations. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildAndRun() {
  const dir = await fs.mkdtemp("/tmp/openorc-composer-changes-");
  await require("./build-transcript-fixture.cjs")(dir, "composer-changes-ui.tsx");
  const html = path.join(dir, "index.html");
  await fs.writeFile(html, (await fs.readFile(html, "utf8")).replace("<head>", '<head><script>window.openorc={platform:"linux"}</script>'));
  const env = { ...process.env, OPENORC_COMPOSER_CHANGES_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

async function smoke() {
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_COMPOSER_CHANGES_DIR;
  app.setPath("userData", path.join(dir, "user-data"));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1000, height: 560, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const read = async (code) => {
    try {
      return await win.webContents.executeJavaScript(code);
    } catch (error) {
      throw Error(`${code}\n${error.message}\n${errors.join("\n")}`);
    }
  };
  const until = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (await read(`Boolean(${code})`)) return;
      await pause(50);
    }
    throw Error(`Timed out: ${code}\n${errors.join("\n")}`);
  };
  const click = (selector) => read(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const capture = async (name) => fs.writeFile(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const geometry = async () => {
    const failures = await read(`(() => {
      const root = document.querySelector('.composer'); const r = root.getBoundingClientRect();
      const errors = [];
      if(root.scrollWidth > root.clientWidth + 1) errors.push('composer overflow');
      const rail = root.querySelector('.composer-rail');
      if(rail && rail.scrollWidth > rail.clientWidth + 1) errors.push('workspace footer overflow');
      for(const button of root.querySelectorAll('button')) {
        const b=button.getBoundingClientRect(); if(!b.width || !b.height) continue;
        if(b.left < r.left - 1 || b.right > r.right + 1) errors.push(button.getAttribute('aria-label') + ' outside composer');
        const hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);
        if(!button.disabled && hit && !button.contains(hit)) errors.push(button.getAttribute('aria-label') + ' obscured');
      }
      return errors;
    })()`);
    assert.deepEqual(failures, []);
  };
  try {
    await win.loadFile(path.join(dir, "index.html"));
    await until("document.querySelector('.composer-changes')");
    if (!process.env.OPENORC_SMOKE_ACTIONS_ONLY) {
      for (const theme of ["dark", "light"]) {
        await read(`changesSmoke.theme('${theme}')`);
        for (const dirty of [false, true]) {
          await read(`changesSmoke.dirty(${dirty})`);
          await until(`Boolean(document.querySelector('.composer-changes')) === ${dirty}`);
          for (const width of [1000, 700, 600, 480, 380]) {
            win.setSize(width, 560);
            await pause(100);
            await geometry();
            assert.equal(await read(`Boolean(document.querySelector('.composer-rail .composer-changes'))`), dirty);
            if (width === 1000 || width === 480) await capture(`${theme}-${dirty ? "dirty" : "clean"}-${width}`);
          }
        }
      }
      await read(`changesSmoke.branch('feature/a-very-long-branch-name-that-must-not-displace-any-composer-controls'); changesSmoke.working(true); changesSmoke.value('Keep all controls reachable');`);
      for (const width of [1000, 700, 600, 480, 380]) {
        win.setSize(width, 560);
        await pause(100);
        await geometry();
      }
      await capture("narrow-active-long-branch");
    }
    await read(`changesSmoke.working(false); changesSmoke.branch('master'); changesSmoke.dirty(true, true); changesSmoke.theme('dark');`);
    win.setSize(1200, 700);
    await until(`document.querySelector('.composer-changes-summary')?.textContent.includes('1 file')`);
    await click(".composer-changes-summary");
    await until(`document.querySelector('.panel-shell[data-open="true"]') && document.body.textContent.includes('mascot.png')`);
    assert.equal(await read(`changesSmoke.layout().workspaceChanges.kind`), "project");
    await click(".composer-changes-commit");
    await until(`document.querySelector('[role="dialog"] textarea')`);
    assert.equal(await read(`changesSmoke.calls.filter(c=>c.method.startsWith('review.commit')).length`), 0);
    await read(
      `(() => {const el=document.querySelector('[role="dialog"] textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Keep commit message'); el.dispatchEvent(new Event('input',{bubbles:true})); changesSmoke.failCommit(true);})()`,
    );
    const commit = () => read(`[...document.querySelectorAll('[role="dialog"] button')].find(b=>b.textContent==='Commit').click()`);
    await commit();
    await until(`document.querySelector('[role="dialog"] [role="alert"]')`);
    assert.equal(await read(`document.querySelector('[role="dialog"] textarea').value`), "Keep commit message");
    await read(`changesSmoke.failCommit(false)`);
    await commit();
    await until(`!document.querySelector('.composer-changes') && !document.querySelector('[role="dialog"]')`);
    assert.equal(await read(`changesSmoke.calls.at(-1).method.startsWith('review.')`), true);
    await read(`changesSmoke.source('thread'); changesSmoke.dirty(true);`);
    await until(`document.querySelector('.composer-changes-commit')`);
    await click(".composer-changes-summary");
    await until(`document.querySelector('.panel-shell[data-thread-owner="thread"][data-open="true"]')`);
    assert.equal(await read(`changesSmoke.layout().workspaceChanges.comparison`), "head");
    await until(`document.body.textContent.includes('Show branch changes')`);
    await read(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Show branch changes').click()`);
    await until(`changesSmoke.calls.some(c=>c.method==='review.threadDiff' && c.input.comparison==='base')`);
    await read(`changesSmoke.close(); changesSmoke.team(true,true)`);
    await until(`document.querySelector('.composer-changes-commit').disabled`);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: clean/dirty layouts in both themes at five widths; long branch, active controls, binary changes, project review/commit retry, thread targeting and branch comparison, blocked team commit. Screenshots:",
      dir,
    );
    app.exit(0);
  } catch (error) {
    await capture("failure");
    console.error(error, errors, "Screenshots:", dir);
    app.exit(1);
  }
}
if (process.versions.electron) void smoke();
else void buildAndRun();
