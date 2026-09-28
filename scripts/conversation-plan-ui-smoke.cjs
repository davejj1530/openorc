/** Production mode selector and plan panel in a disposable Electron profile. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  if (!process.versions.electron) {
    const dir = await fs.mkdtemp("/tmp/openorc-plan-ui-");
    await require("./build-transcript-fixture.cjs")(dir, "conversation-plan-ui.tsx");
    const html = path.join(dir, "index.html");
    await fs.writeFile(html, (await fs.readFile(html, "utf8")).replace("<head>", '<head><script>window.openorc={platform:"linux"}</script>'));
    const env = { ...process.env, OPENORC_PLAN_SMOKE: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_PLAN_SMOKE;
  app.setPath("userData", path.join(dir, "profile"));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", (e) => {
    if (e.level === "error") errors.push(e.message);
  });
  const read = (code) => win.webContents.executeJavaScript(code);
  const until = async (code) => {
    for (let i = 0; i < 80; i++) {
      if (await read(`Boolean(${code})`)) return;
      await pause(100);
    }
    throw Error(`Timed out: ${code}`);
  };
  try {
    await win.loadFile(path.join(dir, "index.html"));
    await until(`document.querySelector('[aria-label="Plan revision"]')`);
    assert.equal(await read(`document.querySelectorAll('.panel-shell').length`), 1);
    assert.equal(await read(`document.querySelectorAll('aside').length`), 1);
    assert.equal(await read(`document.querySelector('[aria-label="Conversation plan"]').closest('.panel-shell') !== null`), true);
    assert.equal(await read(`document.querySelector('[role="tab"][aria-label="Plan"]').getAttribute('aria-selected')`), "true");
    const shots = [];
    for (const [theme, width] of [
      ["light", 1440],
      ["dark", 1440],
      ["light", 800],
      ["dark", 800],
    ]) {
      win.setSize(width, 1000);
      await read(`planSmoke.theme(${JSON.stringify(theme)})`);
      await pause(250);
      assert.equal(await read(`document.documentElement.scrollWidth<=innerWidth`), true);
      const file = path.join(dir, `${theme}-${width}.png`);
      await fs.writeFile(file, (await win.webContents.capturePage()).toPNG());
      shots.push(file);
    }
    win.setSize(1440, 1000);
    await read(`document.querySelector('[aria-label="Resize panel"]').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft', bubbles:true}))`);
    await pause(250);
    assert.equal(await read(`planSmoke.layout().panelWidth > 460`), true);
    await read(`document.querySelector('[role="tab"][aria-label="Tasks"]').click()`);
    await until(`document.querySelector('[role="tab"][aria-label="Tasks"]').getAttribute('aria-selected') === 'true'`);
    assert.equal(await read(`document.querySelector('[aria-label="Conversation plan"]') === null`), true);
    await read(`document.querySelector('[role="tab"][aria-label="Plan"]').click()`);
    await until(`document.querySelector('[aria-label="Plan revision"]')`);
    await read(`document.querySelector('[aria-label="Hide panel"]').click()`);
    await pause(300);
    assert.equal(await read(`document.querySelector('.panel-shell').getAttribute('data-open')`), "false");
    await read(`planSmoke.update('# Updated while hidden')`);
    await pause(150);
    assert.equal(await read(`document.querySelector('.panel-shell').getAttribute('data-open')`), "false");
    await read(`document.querySelector('[aria-label="Show sidebar"]').click()`);
    await until(`document.querySelector('[aria-label="Conversation plan"]')?.textContent.includes('Updated while hidden')`);
    await read(`planSmoke.select('other')`);
    await until(`document.querySelector('[aria-label="Conversation plan"]')?.textContent.includes('Other conversation plan')`);
    assert.equal(await read(`document.querySelector('[aria-label="Plan revision"]').value`), "other-plan");
    await read(`planSmoke.select('thread')`);
    await until(`document.querySelector('[aria-label="Plan revision"]')?.value === 'plan-2'`);
    await read(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Export to project…').click()`);
    await until(`document.querySelector('[aria-label="Plan export filename"]')`);
    await read(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Create Markdown file').click()`);
    await until(`document.body.textContent.includes('Exported to /repo/openorc-plan.md')`);
    await read(`document.querySelector('[aria-label="Mode: Plan"]').click()`);
    await until(`document.querySelector('[role="menu"]')`);
    const items = await read(`Array.from(document.querySelectorAll('[role="menuitem"]')).map(e=>e.textContent)`);
    for (const label of ["Plan", "Review everything", "Accept edits", "Autonomous"])
      assert(
        items.some((t) => t.startsWith(label)),
        label,
      );
    await read(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.startsWith('Review everything')).click()`);
    await until(`document.querySelector('[aria-label="Mode: Review everything"]')`);
    assert.equal(await read(`document.querySelector('textarea')?.value`), "Keep existing threads compatible");
    await read(`planSmoke.provider('codex')`);
    await until(`document.querySelector('[aria-label="Mode: Review changes"]')`);
    assert.equal(await read(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Implement this plan').disabled`), false);
    assert.equal(await read(`document.querySelector('aside').textContent.includes('Read-only sandbox')`), true);
    await read(`document.querySelector('[aria-label="Mode: Review changes"]').click()`);
    await until(`document.querySelector('[role="menu"]')`);
    const codexItems = await read(`Array.from(document.querySelectorAll('[role="menuitem"]')).map(e=>e.textContent)`);
    for (const label of ["Review changes", "Ask for approval", "Full access"])
      assert(
        codexItems.some((t) => t.startsWith(label)),
        label,
      );
    assert(!codexItems.some((t) => t.includes("Every command")));
    await read(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.startsWith('Ask for approval')).click()`);
    await until(`document.querySelector('[aria-label="Mode: Ask for approval"]')`);
    await read(`planSmoke.select('team')`);
    await until(`document.querySelector('aside')?.textContent.includes('Team plan')`);
    await until(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Implement this plan')?.disabled === false`);
    assert.deepEqual(
      await read(`Array.from(document.querySelector('[aria-label="Plan revision"]').options).map(o=>o.value)`),
      ["plan-2"],
      "chat replies and member proposals must not become shared plan revisions",
    );
    assert.equal(await read(`document.querySelector('aside').textContent.includes('saved permissions')`), true);
    assert.equal(await read(`document.querySelector('aside').textContent.includes('Implementation mode')`), false);
    await read(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Implement this plan').click()`);
    await until(`planSmoke.calls.some(c=>c.method==='orchestration.implementPlan')`);
    assert.deepEqual(await read(`planSmoke.calls.find(c=>c.method==='orchestration.implementPlan').input`), { threadId: "team", planId: "plan-2" });
    const teamShot = path.join(dir, "team-plan.png");
    await fs.writeFile(teamShot, (await win.webContents.capturePage()).toPNG());
    shots.push(teamShot);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, screenshots: shots }));
  } finally {
    win.destroy();
    app.quit();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  if (process.versions.electron) require("electron").app.quit();
});
