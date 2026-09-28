/** Run the built app with qa-seed.ts's disposable ledger; never calls an agent. */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "output/icons");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];
let win;
let iconCount;
const read = (code) => win.webContents.executeJavaScript(code);
async function until(code) {
  const start = Date.now();
  while (!(await read(code))) {
    if (Date.now() - start > 15000) throw Error("Timed out: " + code);
    await pause(100);
  }
}
async function click(text) {
  await read(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b)throw Error('Missing button'); b.click(); })()`);
  await pause(200);
}
async function shot(name, window = win) {
  await pause(200);
  await fs.writeFile(path.join(output, name + ".png"), (await window.webContents.capturePage()).toPNG());
}
async function run() {
  await until(`document.querySelectorAll('svg[data-icon]').length > 15`);
  assert.equal(await read(`document.querySelectorAll('svg.lucide').length`), 0);
  const fixtureThread = 'button[title="Make the daily workflow feel effortless"]';
  await until(`Boolean(document.querySelector(${JSON.stringify(fixtureThread)}))`);
  // Opening the seeded thread selects its project before visiting scoped Tasks.
  await read(`document.querySelector(${JSON.stringify(fixtureThread)}).click()`);
  for (const theme of ["light", "dark"]) {
    await read(`localStorage.setItem('openorc.theme',${JSON.stringify(theme)});window.dispatchEvent(new StorageEvent('storage',{key:'openorc.theme'}))`);
    await shot("app-" + theme);
  }
  await click("Tasks");
  await until(`document.querySelector('[data-status-toggle]')`);
  await shot("tasks-dark");
  await read(`document.querySelector('button[title="Make the daily workflow feel effortless"]').click()`);
  await until(`document.querySelector('[aria-label="Show panel"]') || document.querySelector('[role="tab"][aria-label="Changes"]')`);
  await read(`document.querySelector('[aria-label="Show panel"]')?.click()`);
  await until(`document.querySelector('[role="tab"][aria-label="Changes"]')`);
  await read(`(() => { const tab = document.querySelector('[role="tab"][aria-label="Changes"]'); if(tab.getAttribute('aria-selected') !== 'true') tab.click(); })()`);
  await until(`Array.from(document.querySelectorAll('diffs-container')).some(n=>n.shadowRoot?.querySelector('[data-openorc-icons]'))`);
  const diff = await read(
    `(() => {const n=[...document.querySelectorAll('diffs-container')].find(n=>n.shadowRoot?.querySelector('[data-openorc-icons]')); const s=n.shadowRoot; return {symbols:s.querySelectorAll('[data-openorc-icons] symbol').length,uses:[...s.querySelectorAll('use')].every(u=>s.querySelector(u.getAttribute('href'))),strokes:[...s.querySelectorAll('[data-openorc-icons] symbol g')].every(g=>g.getAttribute('stroke-width')==='1.75')};})()`,
  );
  assert.equal(diff.symbols, 17);
  assert.ok(diff.uses);
  assert.ok(diff.strokes);
  await shot("diff-dark");
  await read(`localStorage.setItem('openorc.theme','light');window.dispatchEvent(new StorageEvent('storage',{key:'openorc.theme'}))`);
  win.setSize(1000, 720);
  await shot("diff-narrow-light");
  const gallery = new BrowserWindow({ width: 1600, height: 2700, show: false, webPreferences: { backgroundThrottling: false } });
  await gallery.loadFile(path.join(output, "precision-outline.html"));
  assert.equal(await gallery.webContents.executeJavaScript(`document.querySelectorAll('article').length`), iconCount);
  const clipped = await gallery.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('.specimen svg')).flatMap(s=>{const b=s.getBBox();return b.x < 0 || b.y < 0 || b.x+b.width > 24.1 || b.y+b.height > 24.1 ? [s.dataset.icon] : [];})`,
  );
  assert.deepEqual(clipped, []);
  for (const theme of ["light", "dark"]) {
    await gallery.webContents.executeJavaScript(`document.body.classList.toggle('dark', ${theme === "dark"})`);
    const height = await gallery.webContents.executeJavaScript("document.documentElement.scrollHeight");
    const viewport = await gallery.webContents.executeJavaScript("innerHeight");
    for (let y = 0, page = 0; y < height; y += viewport - 120, page++) {
      await gallery.webContents.executeJavaScript(`window.scrollTo(0, ${y})`);
      await shot(`family-${theme}-${page}`, gallery);
    }
  }
  assert.deepEqual(errors, []);
  const report = {
    icons: iconCount,
    checks: [
      "local icons in app shell and task list",
      "light/dark and narrow desktop captures",
      "all diff sprite references resolve to Codex geometry",
      `all ${iconCount} icon shapes stay inside the viewBox`,
      "gallery theme toggle",
    ],
    errors,
  };
  await fs.writeFile(path.join(output, "verification.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  app.quit();
}
(async () => {
  if (!process.env.OPENORC_QA_FIXTURE) throw Error("Set OPENORC_QA_FIXTURE to a disposable qa-seed.ts fixture.");
  const preview = execFileSync(process.execPath, ["--import", "tsx", "apps/desktop/scripts/icon-preview.mts", "--preview-only"], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TSX_TSCONFIG_PATH: path.join(root, "apps/desktop/tsconfig.web.json") },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  iconCount = JSON.parse(preview).icons;
  assert.ok(Number.isInteger(iconCount) && iconCount > 0, "preview contains icons");
  const fixture = JSON.parse(require("node:fs").readFileSync(process.env.OPENORC_QA_FIXTURE, "utf8"));
  require("node:fs").writeFileSync(path.join(fixture.repo, "README.md"), "# Workflow fixture\n\nPrecision Outline icon smoke fixture.\n");
  process.env.OPENORC_USER_DATA = fixture.data;
  process.env.OPENORC_THEME = "light";
  app.once("browser-window-created", (_event, window) => {
    win = window;
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on("console-message", (e) => {
      if (e.level === "error") errors.push(e.message);
    });
    win.webContents.once(
      "did-finish-load",
      () =>
        void run().catch(async (error) => {
          console.error(error, errors);
          await shot("failure");
          app.exit(1);
        }),
    );
  });
  require(path.join(root, "apps/desktop/out/main/index.mjs"));
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
