/** The sidebar grouped by project: interaction, drag regions and layout checks against production components in Electron. */
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
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error("renderer:", event.message.slice(0, 600));
  });
  const read = (code) =>
    win.webContents.executeJavaScript(code).catch((error) => {
      throw Error(`${error.message}: ${code.slice(0, 160)}`);
    });
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
  const text = (selector) => read(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(e => e.getAttribute("aria-label") ?? e.textContent)`);
  const group = (name) => `section.sidebar-project[aria-label=${JSON.stringify(name)}]`;
  const titles = (selector) => read(`Array.from(document.querySelectorAll(${JSON.stringify(`${selector} .thread-preview-title`)})).map(e => e.textContent)`);
  const press = async (label) => {
    await read(`Array.from(document.querySelectorAll("button")).find(b => (b.getAttribute("aria-label") ?? b.textContent.trim()) === ${JSON.stringify(label)}).click()`);
    await pause(100);
  };
  try {
    await win.loadFile(path.join(dir, "index.html"));
    await read('window.addEventListener("error", (e) => console.error(e.error?.stack ?? e.message)), true');
    await until('document.querySelectorAll(".sidebar-project").length === 4 && document.querySelectorAll("button[draggable]").length >= 8');
    assert.deepEqual(await text("section.sidebar-project"), ["studio", "Website", "A project with a very long name that needs to truncate", "No project"]);
    assert.deepEqual(await text('nav[aria-label="Screens"] .sidebar-nav-label'), ["New thread", "Tasks", "Pull requests", "Schedules", "Orclings"]);
    assert.deepEqual(await titles(".sidebar-section:not(.sidebar-project)"), ["Redesign the sidebar"]);
    assert.equal((await titles(group("studio"))).length, 4);
    assert.equal(await read(`document.querySelector(${JSON.stringify(`${group("Website")} .sidebar-section-toggle`)}).getAttribute("aria-label")`), "Website, 1 waiting");
    assert.equal(await read(`document.querySelectorAll(${JSON.stringify(`${group("studio")} [aria-label=Working]`)}).length`), 1);
    // Rows carry only their titles and marks; metadata is available on hover and keyboard focus.
    assert.equal(await read('document.querySelectorAll(".sidebar-project .thread-preview-project, .thread-preview-headline").length'), 0);
    await press("Show 4 more");
    assert.equal((await titles(group("studio"))).length, 8);
    await read('sidebarSmoke.navigate("openorc-9")');
    await pause(100);
    await click(`${group("studio")} .sidebar-section-toggle`);
    assert.ok((await read("sidebarSmoke.collapsed()")).includes("project:openorc"));
    assert.equal((await titles(group("studio"))).length, 1, "a folded group keeps the open thread");
    await click(`${group("studio")} .sidebar-section-toggle`);
    await press("New thread in studio");
    assert.deepEqual(await read("sidebarSmoke.route()"), { view: "newthread", projectId: "openorc" });
    await click(".sidebar-list-fold");
    assert.equal(await read('document.querySelector(".sidebar-list-fold").getAttribute("aria-label")'), "Workspaces, 1 waiting");
    assert.equal(await read('Array.from(document.querySelectorAll("button[draggable]")).filter(e => e.offsetParent).length'), 0);
    await click(".sidebar-list-fold");
    assert.deepEqual(await text(".sidebar-workspaces .sidebar-list-tools button"), ["Search", "Add project", "Filter threads"]);
    await press("Add project");
    assert.equal((await read("sidebarSmoke.ui()")).importProject, true);
    // Each label leads with its project's mark, centred on the name's line, and the rows stay flush with the mark.
    const marks = await read(`Array.from(document.querySelectorAll(".sidebar-project")).map(group => {
      const mark = group.querySelector(".sidebar-section-toggle > .sidebar-project-mark")?.getBoundingClientRect();
      const name = group.querySelector(".sidebar-project-name").getBoundingClientRect();
      const title = group.querySelector(".thread-preview-title")?.getBoundingClientRect();
      return mark && Math.abs(mark.top + mark.height / 2 - (name.top + name.height / 2)) <= 1 && (!title || Math.abs(title.left - mark.left) <= 1);
    })`);
    assert.deepEqual(
      marks,
      marks.map(() => true),
      "marks sit on the label's line, rows flush with them",
    );
    // The header drags the window; nothing pressable in it, and nothing under it, does.
    const region = (selector) =>
      read(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(e => getComputedStyle(e).webkitAppRegion ?? getComputedStyle(e).getPropertyValue("-webkit-app-region"))`);
    assert.deepEqual(await region(".sidebar-header"), ["drag"]);
    assert.ok(
      (await region(".sidebar-header button")).every((value) => value === "no-drag"),
      "header controls take clicks",
    );
    assert.ok(
      (await region(".sidebar-body, .sidebar-body *, .sidebar-footer, .sidebar-footer *")).every((value) => value !== "drag"),
      "nothing under the header drags",
    );
    for (const theme of ["light", "dark"]) {
      for (const width of [224, 247, 380]) {
        await read(`document.documentElement.dataset.theme = '${theme}'; sidebarSmoke.width(${width})`);
        await pause(250);
        const overflow = await read(
          'Array.from(document.querySelectorAll(".sidebar-shell, .sidebar-body, .browser-threads, .sidebar-project, .sidebar-nav-row, .sidebar-footer")).filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className)',
        );
        assert.deepEqual(overflow, [], `${theme} ${width} overflow`);
        const misfits = await read(`Array.from(document.querySelectorAll('.sidebar-project .sidebar-thread-row')).filter(row => {
          const title = row.querySelector('.thread-preview-title').getBoundingClientRect();
          const box = row.getBoundingClientRect();
          const sidebar = row.closest('.sidebar-shell').getBoundingClientRect();
          const stateX = sidebar.right - 24 - (row.parentElement.hasAttribute('data-parent') ? 24 : 0);
          const centerY = box.top + box.height / 2;
          const slots = [...row.querySelectorAll('.thread-fact-slot')];
          const misplaced = slots.some((slot, index) => {
            const rect = slot.getBoundingClientRect();
            const offset = (slots.length - 1 - index) * 20;
            return Math.abs(rect.x + rect.width / 2 - (stateX - offset)) > 1 || Math.abs(rect.y + rect.height / 2 - centerY) > 1;
          });
          return box.height !== 32 || Math.abs(title.y + title.height / 2 - centerY) > 1 || title.right > box.right || row.scrollWidth > row.clientWidth || misplaced;
        }).map(row => [row.textContent, row.scrollWidth, row.clientWidth])`);
        assert.deepEqual(misfits, [], `${theme} ${width} thread rows`);
        await fs.writeFile(path.join(dir, `${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    await press("Settings");
    assert.equal((await read("sidebarSmoke.route()")).view, "settings");
    await press("Close Settings");
    await read('sidebarSmoke.fail("site")');
    await until('document.querySelector(".browser-threads").textContent.includes("Retry")');
    await read("sidebarSmoke.fail(null)");
    await until('!document.querySelector(".browser-threads").textContent.includes("Retry")');
    console.log(
      `PASS: project groups, screens, paging, folds, scoped creation, Workspaces fold, add project from the head, project marks, drag regions, settings, retry, and six layouts. Captures: ${dir}`,
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}
if (process.versions.electron) void check();
else void build();
