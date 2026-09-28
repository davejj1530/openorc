/** Run against node apps/desktop/memory-review.mjs; synthetic data and disposable Electron profile. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function launch() {
  const dir = await fs.mkdtemp("/tmp/openorc-memory-ui-");
  const env = { ...process.env, OPENORC_MEMORY_UI_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
async function check() {
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_MEMORY_UI_DIR;
  app.setPath("userData", path.join(dir, "profile"));
  setTimeout(() => app.exit(1), 60000).unref();
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const read = (code) => win.webContents.executeJavaScript(code);
  const until = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (await read(`Boolean(${code})`)) return;
      await pause(30);
    }
    throw Error(`Timed out: ${code}`);
  };
  const load = async (query = "") => {
    await win.loadURL(`http://127.0.0.1:5196/memory-review.html?${query}`);
    await until(`document.querySelector('.memory-control h2')?.textContent.includes('OpenOrc memory is')`);
  };
  const click = async (selector, label) => {
    const point = await read(
      `(() => {const els=[...document.querySelectorAll(${JSON.stringify(selector)})];const el=els.find(el=>!${JSON.stringify(label ?? "")}||el.textContent.trim()===${JSON.stringify(label ?? "")});el.scrollIntoView({block:'center',behavior:'instant'});const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,
    );
    win.webContents.sendInputEvent({ type: "mouseMove", ...point });
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await pause(80);
  };
  const capture = async (name) => {
    const measurements = await read(`(() => {
      const clipped=[...document.querySelectorAll('.memory-control,.memory-toolbar,.memory-entry,input,select')].filter(el=>{const r=el.getBoundingClientRect();return r.width&& (r.left<0||r.right>innerWidth+1);}).length;
      const rgb=s=>s.match(/[\\d.]+/g).slice(0,3).map(Number);
      const lum=s=>rgb(s).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((s,n,i)=>s+n*[.2126,.7152,.0722][i],0);
      const contrast=[...document.querySelectorAll('.memory-control p,.memory-entry-body,.memory-entry-meta')].map(el=>{let p=el;while(p.parentElement&&getComputedStyle(p).backgroundColor==='rgba(0, 0, 0, 0)')p=p.parentElement;const f=lum(getComputedStyle(el).color),b=lum(getComputedStyle(p).backgroundColor);return (Math.max(f,b)+.05)/(Math.min(f,b)+.05);});
      return {clipped,overflow:document.documentElement.scrollWidth>innerWidth,contrast};
    })()`);
    assert.equal(measurements.clipped, 0, name);
    assert.equal(measurements.overflow, false, name);
    assert.ok(
      measurements.contrast.every((n) => n >= 4.5),
      `${name}: ${measurements.contrast}`,
    );
    await fs.writeFile(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    return measurements;
  };
  try {
    const layouts = [];
    for (const [theme, width] of [
      ["dark", 1100],
      ["light", 1100],
      ["dark", 720],
      ["light", 390],
    ]) {
      win.setSize(width, 850);
      await load(`theme=${theme}`);
      await until(`document.querySelectorAll('.memory-entry').length===3`);
      layouts.push({ theme, width, ...(await capture(`memory-${theme}-${width}`)) });
    }
    win.setSize(1100, 850);
    await load("state=save-error");
    await click('[role="switch"]');
    await until(`document.querySelector('.memory-control [role="alert"]')?.textContent.includes('Could not change memory')`);
    assert.equal(await read(`document.querySelector('[role="switch"]').checked`), false);
    await capture("memory-save-error");
    await click('.memory-control [role="alert"] button');
    await until(`document.querySelector('.memory-control h2').textContent.endsWith('on')`);
    await click('[role="switch"]');
    await until(`document.querySelector('.memory-control h2').textContent.endsWith('off')`);
    await click(".memory-entry button");
    await until(`document.querySelector('[role="menuitem"]')`);
    await click('[role="menuitem"]');
    await until(`document.querySelector('[aria-label="Memory title"]')`);
    await read(
      `(() => {const el=document.querySelector('[aria-label="Memory title"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'Corrected memory');el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await click(".memory-entry button", "Save");
    await until(`document.querySelector('.memory-entry h3')?.textContent==='Corrected memory'`);
    for (const state of ["empty", "load-error"]) {
      await load(`state=${state}`);
      await until(state === "empty" ? `document.body.textContent.includes('No saved memories yet')` : `document.body.textContent.includes('Could not load memories')`);
      await capture(`memory-${state}`);
    }
    await load("view=settings&theme=light");
    await until(`document.querySelector('select')?.disabled`);
    await capture("memory-settings-off");
    await click('[role="switch"]');
    await until(`!document.querySelector('select').disabled`);
    assert.deepEqual(errors, []);
    await fs.writeFile(
      path.join(dir, "report.json"),
      JSON.stringify(
        { layouts, errors, checks: ["off retention", "confirmed switch state", "failed save retry", "toggle on/off", "edit retained memory", "empty state", "load error", "settings provider gate"] },
        null,
        2,
      ),
    );
    console.log(`Memory UI checks passed. Evidence: ${dir}`);
    app.exit(0);
  } catch (error) {
    await fs.writeFile(path.join(dir, "failure.png"), (await win.webContents.capturePage()).toPNG());
    console.error(await read(`document.body.innerText`));
    console.error(`Evidence: ${dir}`);
    console.error(error);
    console.error(errors);
    app.exit(1);
  }
}
if (process.versions.electron) check();
else launch();
