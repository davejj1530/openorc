/** Grouped sidebar interaction and layout checks against production components. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function build() {
  const dir = await fs.mkdtemp("/tmp/openorc-sidebar-");
  await require("./build-transcript-fixture.cjs")(dir, "sidebar-projects-ui.tsx");
  const env = { ...process.env, OPENORC_SIDEBAR_FIXTURE: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
async function check() {
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_SIDEBAR_FIXTURE;
  app.setPath("userData", path.join(dir, "profile"));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1100, height: 900, titleBarStyle: "hiddenInset", webPreferences: { sandbox: true, contextIsolation: true } });
  const read = (code) => win.webContents.executeJavaScript(code);
  const until = async (code) => {
    for (let n = 0; n < 100; n++) {
      if (await read(`Boolean(${code})`)) return;
      await pause(50);
    }
    throw Error(`Timed out: ${code}`);
  };
  const click = async (selector) => {
    await read(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await pause(100);
  };
  try {
    await win.loadFile(path.join(dir, "index.html"));
    await until('document.querySelectorAll(".sidebar-project").length === 4 && document.querySelectorAll("button[draggable]").length === 10');
    assert.equal(await read('document.querySelectorAll(".rail-chip").length'), 0);
    assert.equal(await read('Array.from(document.querySelectorAll("[aria-label]")).some(e => e.getAttribute("aria-label") === "Team agents: 2 × Codex, 1 × Claude")'), true);
    assert.equal(await read('Array.from(document.querySelectorAll("[aria-label]")).some(e => e.getAttribute("aria-label") === "Agent: Claude")'), true);
    assert.equal(await read('Array.from(document.querySelectorAll("button[title]")).find(e => e.title.startsWith("Plan this week")).textContent.includes("Local")'), true);
    await read('document.documentElement.dataset.theme = "dark"');
    await fs.writeFile(path.join(dir, "thread-rows.png"), (await win.webContents.capturePage()).toPNG());
    assert.equal(await read('document.querySelectorAll("[aria-label=Working]").length'), 1);
    const project = '[aria-label="studio threads"]';
    await click(`${project} button[aria-expanded]`);
    assert.equal(await read('sidebarSmoke.order().some(id => id.startsWith("openorc-"))'), false);
    assert.ok((await read('JSON.parse(localStorage.getItem("openorc.layout")).collapsed')).includes("project:openorc"));
    await read('sidebarSmoke.navigate("openorc-9")');
    await until('Array.from(document.querySelectorAll("button[title]")).some(b => b.title === "One more conversation")');
    assert.equal(await read('Array.from(document.querySelectorAll("button[title]")).find(b => b.title === "One more conversation").getAttribute("aria-current")'), "page");
    await click('[aria-label="New thread in studio"]');
    assert.deepEqual(await read("sidebarSmoke.route()"), { view: "newthread", projectId: "openorc" });
    await until('document.querySelector("button[title=\\"Redesign the sidebar\\"]")');
    await read(`Array.from(document.querySelectorAll('${project} button')).find(b => b.textContent === 'Show more…').click()`);
    await until('document.querySelector("button[title=\\"One more conversation\\"]")');
    await read('Array.from(document.querySelectorAll(".sidebar-project button[aria-expanded]")).find(b => b.textContent.startsWith("Snoozed")).click()');
    await until('sidebarSmoke.order().includes("openorc-6")');
    await read('Array.from(document.querySelectorAll(".sidebar-project button[aria-expanded]")).find(b => b.textContent.startsWith("Snoozed")).click()');
    await until('!sidebarSmoke.order().includes("openorc-6")');
    await click('button[title="Refresh the landing page"]');
    assert.equal(await read("sidebarSmoke.scope()"), "site");
    assert.deepEqual(await read("sidebarSmoke.route()"), { view: "thread", threadId: "site-1" });
    await read('sidebarSmoke.filter("archived")');
    await until('document.querySelector("button[title=\\"An archived conversation\\"]")');
    assert.equal(await read('document.querySelectorAll("button[draggable]").length'), 1);
    await read('sidebarSmoke.filter("active")');
    await until('document.querySelector("button[title=\\"Refresh the landing page\\"]")');
    await click('[aria-label="Add project"]');
    assert.equal((await read("sidebarSmoke.ui()")).importProject, true);
    await read('Array.from(document.querySelectorAll(".sidebar-shell button")).find(b => b.textContent === "Settings").click()');
    assert.equal((await read("sidebarSmoke.route()")).view, "settings");
    for (const theme of ["light", "dark"]) {
      for (const width of [224, 288, 380]) {
        await read(`document.documentElement.dataset.theme = '${theme}'; sidebarSmoke.width(${width})`);
        await pause(250);
        const overflow = await read('Array.from(document.querySelectorAll(".sidebar-shell,.sidebar-threads,.sidebar-project")).some(e => e.scrollWidth > e.clientWidth + 1)');
        assert.equal(overflow, false, `${theme} ${width} overflow`);
        const rowsFit = await read(`Array.from(document.querySelectorAll('.sidebar-thread-row')).every(row => {
          const title = row.children[0].getBoundingClientRect();
          const metadata = row.children[1].getBoundingClientRect();
          const branch = row.children[1].children[0].getBoundingClientRect();
          const agents = row.children[1].children[1].getBoundingClientRect();
          return metadata.top >= title.bottom && branch.right <= agents.left && branch.width > 0 && row.scrollWidth <= row.clientWidth;
        })`);
        assert.equal(rowsFit, true, `${theme} ${width} thread metadata layout`);
        await fs.writeFile(path.join(dir, `${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    await read('sidebarSmoke.fail("site")');
    await until('document.querySelector("[aria-label=\\"Website threads\\"]").textContent.includes("Retry")');
    await read("sidebarSmoke.fail(null)");
    await until('!document.querySelector("[aria-label=\\"Website threads\\"]").textContent.includes("Retry")');
    console.log(`PASS: grouped threads, collapse, scoped creation, pagination, navigation, archive, import, settings, retry, and six layouts. Captures: ${dir}`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}
if (process.versions.electron) void check();
else void build();
