/** Every file in a patch folds to its own row, in the real review surface. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildAndRun() {
  const dir = await fs.mkdtemp("/tmp/openorc-diff-fold-");
  await require("./build-transcript-fixture.cjs")(dir, "diff-fold-ui.tsx");
  const env = { ...process.env, OPENORC_DIFF_FOLD_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

async function checkUI() {
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_DIFF_FOLD_DIR;
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 900, height: 900, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const read = async (code) => {
    try {
      return await win.webContents.executeJavaScript(code);
    } catch (error) {
      throw new Error(`${code}\n${errors.join("\n")}`, { cause: error });
    }
  };
  const shot = async (name) => fs.writeFile(path.join(dir, name + ".png"), (await win.webContents.capturePage()).toPNG());
  const until = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (await read(`Boolean(${code})`)) return;
      await pause(100);
    }
    await shot("failure");
    throw Error(`Timed out: ${code}\n${errors.join("\n")}`);
  };
  const header = (p) => `document.querySelector('section[aria-label="${p}"] .diff-file-header')`;
  const code = (p) => `document.querySelector('section[aria-label="${p}"] diffs-container')`;
  const shadow = (p) => `(${code(p)}?.shadowRoot?.textContent ?? '')`;

  try {
    await win.loadFile(path.join(dir, "index.html"));
    await until(`window.foldSmoke`);
    await read(`foldSmoke.theme('light')`);

    // Every file arrives folded: the panel opens as a list of what changed, not as
    // one worker-highlighted view per file.
    await until(`document.querySelectorAll('.diff-file-header').length === 3`);
    assert.equal(await read(`document.querySelectorAll('diffs-container').length`), 0);
    assert.deepEqual(await read(`Array.from(document.querySelectorAll('.diff-file-header')).map(h => h.getAttribute('aria-expanded'))`), ["false", "false", "false"]);

    // Each fold still states its own status letter, path and counts while shut.
    assert.equal(await read(`${header("src/renderer/src/lib/layout.ts")}.textContent`), "Msrc/renderer/src/lib/layout.ts+2 -1");
    assert.equal(await read(`${header("README.md")}.textContent`), "AREADME.md+2");
    assert.equal(await read(`${header("old.txt")}.textContent`), "Dold.txt-1");

    const chevron = (p) => `getComputedStyle(${header(p)}.querySelector('svg')).rotate`;
    await pause(300); // the chevron rides transition-transform; read it settled
    assert.equal(await read(chevron("README.md")), "none");
    assert.equal(await read(`getComputedStyle(${header("README.md")}).borderBottomWidth`), "0px");
    await shot("folded-light");

    // Opening one mounts that file's code and leaves every other file shut.
    await read(`${header("README.md")}.click()`);
    await until(`${shadow("README.md")}.includes('OpenOrc')`);
    assert.equal(await read(`${header("README.md")}.getAttribute('aria-expanded')`), "true");
    assert.equal(await read(`document.querySelectorAll('diffs-container').length`), 1);
    assert.equal(await read(`${code("old.txt")}`), null);

    // The renderer's own header is gone: the fold is the only one.
    assert.equal(await read(`${shadow("README.md")}.includes('README.md')`), false);

    // The header stays on the scroller's top edge while its file passes under it.
    assert.equal(await read(`getComputedStyle(${header("README.md")}).position`), "sticky");

    // An open fold points its chevron down and rules off its own code.
    await pause(300); // settled, not mid-transition
    assert.equal(await read(chevron("README.md")), "90deg");
    assert.match(await read(`getComputedStyle(${header("README.md")}).borderBottomWidth`), /^1px$/);

    // Folding it again drops the code.
    await read(`${header("README.md")}.click()`);
    await until(`${code("README.md")} === null`);
    assert.equal(await read(`${header("README.md")}.textContent`), "AREADME.md+2");

    await read(`foldSmoke.theme('dark')`);
    await pause(250);
    await shot("folded-dark");

    await read(`foldSmoke.empty()`);
    await until(`document.querySelectorAll('.diff-file-header').length === 0`);
    await read(`foldSmoke.full()`);
    await until(`document.querySelectorAll('.diff-file-header').length === 3`);

    // A patch of one file has nothing to skim and no budget to save, so it opens itself.
    await read(`foldSmoke.single()`);
    await until(`document.querySelectorAll('.diff-file-header').length === 1`);
    await until(`document.querySelector('diffs-container')`);
    assert.equal(await read(`document.querySelector('.diff-file-header').getAttribute('aria-expanded')`), "true");

    // Collapsing a sticky header midway through a long file keeps that file
    // under the pointer, even with another expanded file above it.
    await read(`foldSmoke.long()`);
    await until(`document.querySelectorAll('.diff-file-header').length === 45`);
    for (const file of ["file-0.ts", "file-1.ts"]) {
      await read(`${header(file)}.click()`);
      await until(`${shadow(file)}.includes('value0')`);
    }
    await pause(300);
    await read(`document.querySelector('.diffscroll').scrollTop = document.querySelector('section[aria-label="file-1.ts"]').offsetTop + 400`);
    await pause(300);
    const before = await read(`${header("file-1.ts")}.getBoundingClientRect().top`);
    assert.ok(Math.abs(before) < 2, `Header must be sticky before collapse: ${before}`);
    await read(`${header("file-1.ts")}.click()`);
    await until(`${code("file-1.ts")} === null`);
    await pause(300);
    const after = await read(`${header("file-1.ts")}.getBoundingClientRect().top`);
    assert.ok(Math.abs(after - before) < 2, `Clicked file moved after collapse: ${before} -> ${after}`);

    // Reopening survives the worker's asynchronous rendering, and subsequent
    // user scrolling remains free rather than continuously snapping back.
    await read(`${header("file-1.ts")}.click()`);
    await until(`${shadow("file-1.ts")}.includes('value0')`);
    await pause(300);
    assert.ok(Math.abs((await read(`${header("file-1.ts")}.getBoundingClientRect().top`)) - before) < 2);
    const scrollTop = await read(`document.querySelector('.diffscroll').scrollTop`);
    await read(`document.querySelector('.diffscroll').scrollTop += 200`);
    await pause(300);
    assert.ok(Math.abs((await read(`document.querySelector('.diffscroll').scrollTop`)) - scrollTop - 200) < 2);

    // A header lower down also stays at its clicked position, rather than
    // jumping to the top when opened.
    await read(`${header("file-1.ts")}.click()`);
    await pause(300);
    const lowerBefore = await read(`${header("file-3.ts")}.getBoundingClientRect().top`);
    await read(`${header("file-3.ts")}.click()`);
    await until(`${shadow("file-3.ts")}.includes('value0')`);
    await pause(300);
    assert.ok(Math.abs((await read(`${header("file-3.ts")}.getBoundingClientRect().top`)) - lowerBefore) < 2);

    // The docked sidebar's unified view keeps a stuck header in place too.
    win.setSize(420, 900);
    await pause(300);
    await read(`document.querySelector('.diffscroll').scrollTop = document.querySelector('section[aria-label="file-3.ts"]').offsetTop + 400`);
    await pause(300);
    const narrowBefore = await read(`${header("file-3.ts")}.getBoundingClientRect().top`);
    assert.ok(Math.abs(narrowBefore) < 2, `Header must be sticky before collapse in the sidebar: ${narrowBefore}`);
    await read(`${header("file-3.ts")}.click()`);
    await until(`${code("file-3.ts")} === null`);
    await pause(300);
    const narrowAfter = await read(`${header("file-3.ts")}.getBoundingClientRect().top`);
    assert.ok(Math.abs(narrowAfter - narrowBefore) < 2, `Clicked file moved after collapse in the sidebar: ${narrowBefore} -> ${narrowAfter}`);

    // At the natural scroll limit, collapsing the last file leaves its header in view.
    await read(`document.querySelector('.diffscroll').scrollTop = document.querySelector('.diffscroll').scrollHeight`);
    await read(`${header("file-44.ts")}.click()`);
    await until(`${code("file-44.ts")} !== null`);
    await pause(300);
    await read(`document.querySelector('.diffscroll').scrollTop += 400`);
    await pause(300);
    await read(`${header("file-44.ts")}.click()`);
    await until(`${code("file-44.ts")} === null`);
    await pause(300);
    const last = await read(`(() => {
      const header = ${header("file-44.ts")}.getBoundingClientRect();
      const viewport = document.querySelector('.diffscroll').getBoundingClientRect();
      return { top: header.top - viewport.top, bottom: header.bottom - viewport.bottom };
    })()`);
    assert.ok(last.top >= 0 && last.bottom <= 1, `Last file must remain visible: ${JSON.stringify(last)}`);

    assert.deepEqual(errors, []);
    console.log("diff fold UI smoke passed; screenshots in", dir);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

if (process.versions.electron) void checkUI();
else void buildAndRun();
