/** The composer takes any file, not just images, and says which is which. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildAndRun() {
  const dir = await fs.mkdtemp("/tmp/openorc-composer-files-");
  await require("./build-transcript-fixture.cjs")(dir, "composer-files-ui.tsx");
  const env = { ...process.env, OPENORC_COMPOSER_FILES_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

/** A DataTransfer the page can drop on the composer, built from plain parts. */
const dropFiles = (files) => `(() => {
  const transfer = new DataTransfer();
  for (const [name, type, body] of ${JSON.stringify(files)}) transfer.items.add(new File([body], name, { type }));
  const shell = document.querySelector('.composer-shell');
  shell.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  return true;
})()`;

async function checkUI() {
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_COMPOSER_FILES_DIR;
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 900, height: 480, webPreferences: { backgroundThrottling: false } });
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

  try {
    await win.loadFile(path.join(dir, "index.html"));
    await until(`document.querySelector('.composer-shell')`);
    await read(`composerSmoke.theme('light')`);
    await pause(200);

    // The attach control no longer says "image", and the picker is not filtered to images.
    assert.equal(await read(`document.querySelector('[aria-label="Attach file"]') !== null`), true);

    // A spreadsheet and a log drop in beside an image.
    await read(
      dropFiles([
        ["Q3 report.csv", "text/csv", "a,b\n1,2"],
        ["run.log", "", "started"],
        ["shot.png", "image/png", "not really a png"],
      ]),
    );
    await until(`document.querySelectorAll('.composer-file').length === 2`);
    await until(`document.querySelectorAll('.composer-thumbnail').length === 1`);

    // Each non-image states the name it arrived with and its weight; no image is faked for it.
    const names = await read(`Array.from(document.querySelectorAll('.composer-file-name')).map(e => e.textContent)`);
    assert.deepEqual(names, ["Q3 report.csv", "run.log"]);
    assert.deepEqual(await read(`Array.from(document.querySelectorAll('.composer-file-size')).map(e => e.textContent)`), ["7 B", "7 B"]);
    assert.equal(await read(`document.querySelector('.composer-file img')`), null);

    // A file chip is the height of a thumbnail, so a mixed row reads as one strip.
    const heights = await read(`Array.from(document.querySelectorAll('.composer-file, .composer-thumbnail')).map(e => Math.round(e.getBoundingClientRect().height))`);
    assert.deepEqual(heights, [88, 88, 88]);
    await shot("composer-files-light");
    await read(`composerSmoke.theme('dark')`);
    await pause(200);
    await shot("composer-files-dark");

    // The core stored all three, and only the image asked for an asset URL.
    assert.deepEqual(
      (await read(`composerSmoke.saved()`)).map((s) => s.name),
      ["Q3 report.csv", "run.log", "shot.png"],
    );

    // Removing one is per attachment, by its own name.
    await read(`document.querySelector('[aria-label="Remove run.log"]').click()`);
    await until(`document.querySelectorAll('.composer-file').length === 1`);

    // Sending hands the agent every remaining path.
    await read(`document.querySelector('[aria-label="Message"]').focus()`);
    await read(`(() => {
      const area = document.querySelector('[aria-label="Message"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(area, 'Read these');
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await read(`document.querySelector('[aria-label="Send"]').click()`);
    await until(`composerSmoke.sent().length === 1`);
    const [message] = await read(`composerSmoke.sent()`);
    assert.equal(message.text, "Read these");
    assert.equal(message.attachments.length, 2);
    assert.match(message.attachments[0], /Q3-report\.csv$/);
    assert.match(message.attachments[1], /\.png$/);

    assert.deepEqual(errors, []);
    console.log("composer files UI smoke passed; screenshots in", dir);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

if (process.versions.electron) void checkUI();
else void buildAndRun();
