/** The conversation's tail presence: a WebGPU orb that rests between turns and stirs during one. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildAndRun() {
  const dir = await fs.mkdtemp("/tmp/openorc-agent-orb-");
  await require("./build-transcript-fixture.cjs")(dir, "agent-orb-ui.tsx");
  const env = { ...process.env, OPENORC_AGENT_ORB_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

async function checkUI() {
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_AGENT_ORB_DIR;
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 600, height: 240, webPreferences: { backgroundThrottling: false } });
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
  const orb = `document.querySelector('.agent-orb')`;
  /** A WebGPU canvas cannot be read back through a 2D context, so the evidence is the window itself. */
  const shades = async () => {
    const box = await read(`(({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }))(${orb}.getBoundingClientRect())`);
    const bitmap = (await win.webContents.capturePage(box)).toBitmap();
    const seen = new Set();
    for (let i = 0; i < bitmap.length; i += 4) seen.add(`${bitmap[i]},${bitmap[i + 1]},${bitmap[i + 2]}`);
    return seen;
  };

  try {
    await win.loadFile(path.join(dir, "index.html"));
    await until(`window.orbSmoke`);
    await read(`orbSmoke.theme('light')`);
    await pause(200);
    assert.equal(await read(`Boolean(navigator.gpu)`), true, "this machine exposes no WebGPU, so the smoke cannot see the orb");

    // Resting: the orb is already on screen before any turn has run, and painting.
    await until(`${orb}?.querySelector('canvas')`);
    await until(`${orb}.querySelector('canvas').style.opacity === '1'`);
    assert.equal(await read(`${orb}.dataset.state`), "idle");
    assert.equal(await read(`document.querySelector('[data-row="working"]')`), null);
    assert.ok((await shades()).size > 3, "the resting orb is a flat rectangle");

    // An artwork box rather than a glyph: it is the one thing on the row to look at.
    assert.equal(await read(`Math.round(${orb}.getBoundingClientRect().width)`), 36);
    assert.equal(await read(`Math.round(${orb}.getBoundingClientRect().height)`), 36);
    const resting = await read(`${orb}.getBoundingClientRect().top`);
    await shot("idle-light");

    // Working: the same canvas in the other state, in the same place.
    await read(`orbSmoke.live(true)`);
    await until(`document.querySelector('[data-row="working"]')`);
    assert.equal(await read(`${orb}.dataset.state`), "thinking");
    assert.equal(await read(`${orb}.querySelector('canvas') !== null`), true);
    assert.equal(await read(`${orb}.getBoundingClientRect().top`), resting);
    assert.ok((await shades()).size > 3, "the working orb is a flat rectangle");
    await shot("working-light");
    await read(`orbSmoke.theme('dark')`);
    await pause(400);
    await shot("working-dark");

    // And it settles rather than leaving: the conversation keeps the agent.
    await read(`orbSmoke.live(false)`);
    await until(`${orb}.dataset.state === 'idle'`);
    assert.equal(await read(`document.querySelector('[data-row="working"]')`), null);
    assert.equal(await read(`${orb}.querySelector('canvas') !== null`), true);
    assert.equal(await read(`${orb}.getBoundingClientRect().top`), resting);
    await shot("idle-dark");

    assert.deepEqual(errors, []);
    console.log("agent orb UI smoke passed; screenshots in", dir);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

if (process.versions.electron) void checkUI();
else void buildAndRun();
