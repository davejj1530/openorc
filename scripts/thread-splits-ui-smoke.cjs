/** Production renderer end-to-end split checks in a disposable Electron profile. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildAndRun() {
  const dir = await fs.mkdtemp("/tmp/openorc-thread-splits-");
  await require("./build-transcript-fixture.cjs")(dir, "thread-splits-ui.tsx");
  const env = { ...process.env, OPENORC_SPLITS_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

async function checkUI() {
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_SPLITS_DIR;
  app.setPath("userData", path.join(dir, "profile"));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1900, height: 950, titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 16 }, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", (e) => {
    if (e.level === "error") errors.push(e.message);
  });
  const read = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    await pause(300);
    await fs.writeFile(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const until = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (await read(`Boolean(${code})`)) return;
      await pause(100);
    }
    throw Error(`Timed out: ${code}\n${errors.join("\n")}`);
  };
  const pane = (id) => `[data-thread-pane="${id}"]`;
  const click = (selector) => read(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const pointerClick = async (selector) => {
    const point = await read(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)}), r = el.getBoundingClientRect();
      const x = Math.round(r.x+r.width/2), y = Math.round(r.y+r.height/2);
      if (!el.contains(document.elementFromPoint(x,y))) throw Error('Control is covered');
      return { x, y };
    })()`);
    win.webContents.sendInputEvent({ type: "mouseMove", ...point });
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  };
  const draft = (id, text) =>
    read(
      `(() => { const el = document.querySelector('${pane(id)} textarea'); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); el.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
  const drag = (id, invalid = false) =>
    read(`(() => {
    const source = document.querySelector('button[title="Thread ${id.toUpperCase()}"]');
    const target = document.querySelector('.thread-pane-viewport');
    const dataTransfer = new DataTransfer();
    ${invalid ? `dataTransfer.setData('application/x-openorc-thread', '${id}');` : `source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));`}
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
  })()`);
  const ids = () => read(`splitSmoke.ids()`);
  const widths = () => read(`Array.from(document.querySelectorAll('[data-thread-pane]')).map(el => el.getBoundingClientRect().width)`);
  const focused = () => read(`document.querySelector('[data-thread-pane][data-focused="true"]').dataset.threadPane`);
  const checkDragRegions = async () => {
    const regions = await read(`Array.from(document.querySelectorAll('[data-thread-pane] header')).map(header => ({
      header: getComputedStyle(header).webkitAppRegion,
      surface: header.querySelector('.thread-header-drag-surface')?.getAttribute('aria-hidden'),
      title: header.querySelector('[title^="Thread "]')?.tagName,
      staticRegions: Array.from(header.querySelectorAll('span[title]')).map(el => ({ region: getComputedStyle(el).webkitAppRegion, selection: getComputedStyle(el).userSelect })),
      controls: Array.from(header.querySelectorAll('button, input, a')).map(el => getComputedStyle(el).webkitAppRegion),
      controlsReachable: Array.from(header.querySelectorAll('button, input, a')).every(el => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x+r.width/2, r.y+r.height/2));
      }),
      broadExclusions: header.querySelectorAll('div.no-drag').length,
    }))`);
    for (const region of regions) {
      assert.equal(region.header, "drag");
      assert.equal(region.surface, "true");
      assert.equal(region.title, "SPAN");
      assert(region.staticRegions.every(({ region, selection }) => region === "drag" && selection === "none"));
      assert(region.controls.every((value) => value === "no-drag"));
      assert(region.controlsReachable, "Header controls must remain above the drag surface");
      assert.equal(region.broadExclusions, 0);
    }
  };
  const checkHeaderFocus = async (id, active) => {
    for (const selector of [
      `${pane(id)} header`,
      `${pane(id)} .thread-header-drag-surface`,
      `${pane(id)} .header-chip`,
      `${pane(id)} header [title="Thread ${id.toUpperCase()}"]`,
      `${pane(id)} [aria-label="Show panel"]`,
    ]) {
      await read(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
      })()`);
      assert.equal(await focused(), active, `${selector} must not activate its pane`);
      if (selector.endsWith(".header-chip") && (await read(`Boolean(document.querySelector('[role="menu"]'))`))) {
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await until(`!document.querySelector('[role="menu"]')`);
      }
    }
  };
  try {
    await win.loadFile(path.join(dir, "index.html"), { query: { platform: process.platform } });
    // Keep real desktop pointer movement from interfering with injected renderer input.
    win.webContents.focus();
    await until(`document.querySelector('${pane("a")} textarea')`);
    // The entire sidebar partition must grab, without covering its scrollbar.
    const sidebarHandle = '.resize-handle[data-edge="sidebar"]';
    const sidebarWidth = await read(`Number(document.querySelector('${sidebarHandle}').getAttribute('aria-valuenow'))`);
    for (const fraction of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const point = await read(`(() => {
        const h=document.querySelector('${sidebarHandle}'), r=h.getBoundingClientRect();
        const grip=h.querySelector('.resize-grip').getBoundingClientRect();
        if(Math.abs(grip.x+grip.width/2-r.x)>0.5) throw Error('Sidebar grip must be centered on the partition');
        const x=Math.round(r.x+3), y=Math.round(r.top+r.height*${fraction});
        if(document.elementFromPoint(x,y)?.closest('.resize-handle')!==h) throw Error('Sidebar partition misses at height ${fraction}');
        const scroller=document.querySelector('.sidebar-threads'), s=scroller.getBoundingClientRect();
        if(document.elementFromPoint(s.right-3,s.top+s.height/2)?.closest('.resize-handle')) throw Error('Resize handle covers sidebar scrollbar');
        return {x,y};
      })()`);
      await read(`document.activeElement?.blur()`);
      win.webContents.sendInputEvent({ type: "mouseMove", x: point.x + 100, y: point.y });
      await until(`Number(getComputedStyle(document.querySelector('${sidebarHandle} .resize-grip')).opacity)<0.1`);
      win.webContents.sendInputEvent({ type: "mouseMove", ...point });
      await until(`Number(getComputedStyle(document.querySelector('${sidebarHandle} .resize-grip')).opacity)>0.9`);
      win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
      win.webContents.sendInputEvent({ type: "mouseMove", x: point.x + 32, y: point.y });
      win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: point.x + 32, y: point.y });
      await until(`Number(document.querySelector('${sidebarHandle}').getAttribute('aria-valuenow'))===${sidebarWidth + 32}`);
      await read(`splitSmoke.sidebar(true, ${sidebarWidth})`);
      await pause(250);
    }
    await checkDragRegions();
    await draft("a", "Draft alpha");
    await drag("b", true);
    await pause(100);
    assert.deepEqual(await ids(), ["a"]);
    // Hold a native HTML drag over the viewport long enough to verify its preview.
    await read(`(() => {
      window.splitTransfer = new DataTransfer();
      document.querySelector('button[title="Thread B"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: splitTransfer }));
      document.querySelector('.thread-pane-viewport').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: splitTransfer }));
    })()`);
    await until(`document.querySelector('.thread-drop-preview')`);
    assert(await read(`document.querySelector('.thread-drop-preview').getBoundingClientRect().top >= document.querySelector('[data-thread-pane] header').getBoundingClientRect().bottom`));
    await shot("drop-preview");
    await read(`document.querySelector('button[title="Thread B"]').dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: splitTransfer }))`);
    await until(`!document.querySelector('.thread-drop-preview')`);
    await drag("b");
    await until(`document.querySelector('${pane("b")} textarea')`);
    assert.deepEqual(await ids(), ["a", "b"]);
    await checkHeaderFocus("b", "a");
    await checkDragRegions();
    await draft("b", "Draft bravo");
    // Two-pane pointer resize and cancel through the actual Chromium pointer capture path.
    const before = await widths();
    const point = await read(`(() => { const r = document.querySelector('[data-edge="thread"]').getBoundingClientRect(); return { x: Math.round(r.x - 3), y: Math.round(r.y + r.height / 2) }; })()`);
    await until(`document.elementFromPoint(${point.x}, ${point.y})?.closest('[data-edge="thread"]')`);
    win.webContents.sendInputEvent({ type: "mouseMove", ...point });
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    await until(`document.body.dataset.resizing === 'thread'`);
    win.webContents.sendInputEvent({ type: "mouseMove", modifiers: ["leftButtonDown"], x: point.x + 75, y: point.y });
    await until(`document.querySelector('${pane("a")}').getBoundingClientRect().width > ${before[0] + 50}`);
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: point.x + 75, y: point.y });
    await pause(150);
    const resized = await widths();
    assert(resized[0] > before[0] + 50, `pointer resize ${before} -> ${resized}`);
    win.webContents.sendInputEvent({ type: "mouseMove", x: point.x + 75, y: point.y });
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: point.x + 75, y: point.y });
    await until(`document.body.dataset.resizing === 'thread'`);
    win.webContents.sendInputEvent({ type: "mouseMove", modifiers: ["leftButtonDown"], x: point.x + 120, y: point.y });
    await until(`document.querySelector('${pane("a")}').getBoundingClientRect().width > ${resized[0] + 20}`);
    await read(`document.querySelector('[data-edge="thread"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: point.x + 120, y: point.y });
    await pause(100);
    const cancelled = await widths();
    assert(Math.abs(cancelled[0] - resized[0]) < 1);
    assert.equal(await read(`document.body.dataset.resizing`), undefined);
    await shot("two-threads");
    await drag("c");
    await until(`document.querySelector('${pane("c")} textarea')`);
    await draft("c", "Draft charlie");
    await checkHeaderFocus("a", "c");
    await checkHeaderFocus("b", "c");
    await checkDragRegions();
    // Keyboard focus and body clicks activate panes, but header controls do not.
    await read(`document.querySelector('${pane("b")} textarea').focus()`);
    assert.equal(await focused(), "b");
    await read(`document.querySelector('${pane("c")} .thread-pane-content').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`);
    assert.equal(await focused(), "c");
    // Rename stays available from an unfocused thread's real menu and targets that thread.
    await read(`(() => {
      const el = document.querySelector('${pane("b")} [aria-label="Thread actions"]');
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    })()`);
    await until(`document.querySelector('[role="menu"]')`);
    assert.equal(await focused(), "c");
    await read(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(el => el.textContent === 'Rename').click()`);
    await until(`document.activeElement === document.querySelector('${pane("b")} input[aria-label="Thread title"]')`);
    assert(
      await read(`(() => {
      const el = document.activeElement, r = el.getBoundingClientRect(), style = getComputedStyle(el);
      return style.webkitAppRegion === 'no-drag' && style.userSelect === 'text' && document.elementFromPoint(r.x+r.width/2,r.y+r.height/2) === el;
    })()`),
    );
    assert.equal(await focused(), "c");
    await read(`(() => {
      const el = document.querySelector('${pane("b")} input[aria-label="Thread title"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'Renamed bravo');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await read(`document.querySelector('${pane("b")} input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await until(`splitSmoke.calls().some(c => c.method === 'threads.update' && c.params.id === 'b' && c.params.patch.title === 'Renamed bravo')`);
    assert.equal(await focused(), "c");
    // The sidebar label now reflects the rename; duplicate drop still uses the same id.
    await read(`(() => {
      const source = document.querySelector('button[title="Renamed bravo"]');
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
      document.querySelector('.thread-pane-viewport').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
    })()`);
    await drag("d");
    await pause(100);
    assert.deepEqual(await ids(), ["a", "b", "c"]);
    // All three writing surfaces retain their own value.
    assert.deepEqual(await read(`Array.from(document.querySelectorAll('[data-thread-pane] textarea')).map(e => e.value)`), ["Draft alpha", "Draft bravo", "Draft charlie"]);
    const three = await widths();
    await read(`document.querySelector('[data-edge="thread"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))`);
    await pause(100);
    const keyed = await widths();
    assert(keyed[0] > three[0]);
    assert(Math.abs(keyed[2] - three[2]) < 1);
    // Shared panel follows toggles, not focus, and stays after the conversation group.
    await pointerClick(`${pane("a")} [aria-label="Show panel"]`);
    await until(`document.querySelector('.panel-shell[data-open="true"][data-thread-owner="a"]')`);
    assert.equal(await focused(), "c");
    await draft("b", "Draft bravo");
    assert.equal(await read(`document.querySelector('.panel-shell').dataset.threadOwner`), "a");
    await read(`document.querySelector('${pane("c")} textarea').focus()`);
    await read(`(() => {
      const el = document.querySelector('${pane("b")} [aria-label="Show panel"]');
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      el.focus();
      el.click();
    })()`);
    await until(`document.querySelector('.panel-shell[data-thread-owner="b"]')`);
    assert.equal(await focused(), "c");
    assert.equal(await read(`document.querySelectorAll('.panel-shell').length`), 1);
    assert.equal(await read(`document.querySelector('.work-row').lastElementChild.classList.contains('panel-shell')`), true);
    await click(`${pane("b")} [aria-label="Hide panel"]`);
    await until(`document.querySelector('.panel-shell[data-open="false"]')`);
    // Live message deltas remain in their thread.
    await read(`splitSmoke.emit('a', 'ALPHA_STREAM')`);
    await read(`splitSmoke.emit('b', 'BRAVO_STREAM')`);
    await until(`document.querySelector('${pane("a")}').textContent.includes('ALPHA_STREAM')`);
    await until(`document.querySelector('${pane("b")}').textContent.includes('BRAVO_STREAM')`);
    assert(!(await read(`document.querySelector('${pane("a")}').textContent.includes('BRAVO_STREAM')`)));
    assert(!(await read(`document.querySelector('${pane("c")}').textContent.includes('ALPHA_STREAM')`)));
    // Reading earlier content in A survives both A and B streaming further.
    await read(`splitSmoke.emit('a', Array.from({length: 80}, (_, i) => String.fromCharCode(10, 10) + 'Paragraph ' + i + ' for scroll isolation.').join(''))`);
    await until(`document.querySelector('${pane("a")} [data-transcript]').scrollHeight > 1500`);
    await read(
      `(() => { const el = document.querySelector('${pane("a")} [data-transcript]'); el.dispatchEvent(new WheelEvent('wheel', { deltaY: -400 })); el.scrollTop = 80; el.dispatchEvent(new Event('scroll')); })()`,
    );
    await read(`splitSmoke.emit('b', ' BRAVO_MORE')`);
    await read(`splitSmoke.emit('a', ' ALPHA_MORE')`);
    await pause(250);
    assert(Math.abs((await read(`document.querySelector('${pane("a")} [data-transcript]').scrollTop`)) - 80) < 2);
    // Sending in C targets only C; the fixture records RPC without starting a provider.
    await click(`${pane("c")} button[aria-label="Send"]`);
    await until(`splitSmoke.calls().some(c => c.method === 'runs.start' && c.params.threadId === 'c')`);
    assert.equal(await read(`document.querySelector('${pane("a")} textarea').value`), "Draft alpha");
    await shot("three-threads-light");
    await read(`splitSmoke.theme('dark')`);
    await shot("three-threads-dark");
    win.setSize(980, 760);
    await pause(200);
    assert((await widths()).every((w) => w >= 359));
    assert(await read(`document.querySelector('.thread-pane-viewport').scrollWidth > document.querySelector('.thread-pane-viewport').clientWidth`));
    assert(await read(`document.documentElement.scrollWidth <= innerWidth`));
    await shot("constrained");
    // Navigation replaces focused B and keeps A's exact DOM (and scroll state).
    await draft("b", "Draft bravo");
    await read(`window.alphaPane = document.querySelector('${pane("a")} textarea')`);
    await click('button[title="Thread D"]');
    await until(`document.querySelector('${pane("d")} textarea')`);
    assert.deepEqual(await ids(), ["a", "d", "c"]);
    assert(await read(`window.alphaPane === document.querySelector('${pane("a")} textarea')`));
    await click('button[title="Renamed bravo"]');
    await until(`document.querySelector('${pane("b")} textarea')?.value === 'Draft bravo'`);
    // Closing/removing an owner clears the panel without touching sessions.
    await click(`${pane("b")} [aria-label="Show panel"]`);
    await read(`document.querySelector('${pane("a")} textarea').focus()`);
    await click(`${pane("b")} [aria-label="Close pane"]`);
    await until(`splitSmoke.ids().length === 2`);
    assert.deepEqual(await ids(), ["a", "c"]);
    assert.equal(await focused(), "a");
    assert(!(await read(`document.querySelector('.panel-shell[data-open="true"]')`)));
    await click(`${pane("c")} [aria-label="Show panel"]`);
    await read(`splitSmoke.remove('c')`);
    await until(`splitSmoke.ids().length === 1`);
    assert.deepEqual(await ids(), ["a"]);
    assert(!(await read(`splitSmoke.calls().some(c => ['runs.stop', 'threads.delete'].includes(c.method))`)));
    assert.equal(await read(`document.querySelector('${pane("a")} textarea').value`), "Draft alpha");
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        result: "passed",
        captures: dir,
        checks:
          "1/2/3 pane drag CSS; header pointer/focus isolation, body/composer activation, unfocused rename/panel/close; invalid/duplicate/fourth drops, pointer and keyboard resize, drafts, sends, live deltas, navigation, close/removal, constrained widths (native window movement unverified)",
      }),
    );
    app.exit(0);
  } catch (e) {
    await shot("failure");
    console.error(e, { captures: dir, errors });
    app.exit(1);
  }
}
if (process.versions.electron) void checkUI();
else void buildAndRun();
