/** Exercise production onboarding with synthetic RPC data in an isolated Electron profile. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function buildAndRun() {
  const dir = await fs.mkdtemp("/tmp/openorc-onboarding-ui-");
  await require("./build-transcript-fixture.cjs")(dir, "onboarding-ui.tsx");
  const env = { ...process.env, OPENORC_ONBOARDING_UI_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => (process.exitCode = code ?? 1));
}
async function checkUI() {
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_ONBOARDING_UI_DIR;
  app.setPath("userData", path.join(dir, "profile"));
  setTimeout(() => app.exit(1), 60000).unref();
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const read = (code) => win.webContents.executeJavaScript(code);
  const until = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (await read(`Boolean(${code})`)) return;
      await pause(50);
    }
    throw Error(`Timed out: ${code}\n${errors.join("\n")}`);
  };
  const click = async (name) => {
    await read(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(name)}).click()`);
    await pause(60);
  };
  const capture = async (name) => {
    await until(
      `matchMedia('(prefers-reduced-motion: reduce)').matches ? document.querySelector('.onboarding-mascot .rive-mascot-static') : document.querySelector('.onboarding-mascot .rive-mascot')?.dataset.ready === 'true'`,
    );
    await pause(120);
    const layout = await read(`(() => {
      const visible = element => {const b=element.getBoundingClientRect();return b.width>0&&b.height>0;};
      const footer = document.querySelector('.onboarding-footer');
      const chromeAction = document.querySelector('.onboarding-preview-trigger');
      if (chromeAction && chromeAction.getBoundingClientRect().bottom > document.querySelector('.onboarding-chrome').getBoundingClientRect().bottom) throw Error('Header action clipped');
      return { overflow: document.documentElement.scrollWidth > innerWidth, progress: visible(document.querySelector('.onboarding-progress') ?? document.querySelector('h1')), footerVisible: !footer || footer.getBoundingClientRect().bottom <= innerHeight, clipped: [...document.querySelectorAll('.harness-row,.onboarding-project-row,.onboarding-progress,.onboarding-footer,.onboarding-preview-trigger,.onboarding-mascot')].filter(element => { const b=element.getBoundingClientRect(); return b.left<0||b.right>innerWidth; }).length };
    })()`);
    assert.deepEqual(layout, { overflow: false, progress: true, footerVisible: true, clipped: 0 }, name);
    const contrast = await read(`(() => {
      const canvas = document.createElement('canvas'); canvas.width=canvas.height=1; const ctx=canvas.getContext('2d');
      const rgb = value => {ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
      const luminance = values => values.slice(0,3).map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
      return [...document.querySelectorAll('.onboarding-heading p,.harness-guidance,.onboarding-action-note,.onboarding-project-path')].map(el=>{
        let parent=el,bg; do {bg=rgb(getComputedStyle(parent).backgroundColor);parent=parent.parentElement;} while(bg[3]===0 && parent);
        const fg=luminance(rgb(getComputedStyle(el).color)), back=luminance(bg);
        return (Math.max(fg,back)+0.05)/(Math.min(fg,back)+0.05);
      });
    })()`);
    assert.ok(
      contrast.every((ratio) => ratio >= 4.5),
      name + " text contrast: " + contrast,
    );
    await fs.writeFile(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await win.loadFile(path.join(dir, "index.html"), { query: { startup: "1" } });
    await until(`document.querySelector('[aria-label="Checking setup"]')`);
    for (const zoom of [1, 0.75, 1.5]) {
      win.webContents.setZoomFactor(zoom);
      await read(`document.documentElement.style.setProperty('--window-zoom', '${zoom}')`);
      const left = await read(`document.querySelector('.onboarding-brand').getBoundingClientRect().left`);
      assert.ok(Math.abs(left * zoom - 84) < 1, `Initial title must clear 84 physical pixels for traffic lights at zoom ${zoom}; got ${left * zoom}`);
    }
    win.webContents.setZoomFactor(1);
    await read(`document.documentElement.style.setProperty('--window-zoom', '1'); onboardingStartupSmoke.fullscreen(true); undefined`);
    await until(`!document.querySelector('.onboarding-chrome').hasAttribute('data-traffic-lights')`);
    assert.equal(await read(`document.querySelector('.onboarding-brand').getBoundingClientRect().left`), 16, "Fullscreen releases the native controls' space");
    await read(`onboardingStartupSmoke.fullscreen(false); undefined`);
    await until(`document.querySelector('.onboarding-chrome').getAttribute('data-traffic-lights') === 'true'`);
    await fs.writeFile(path.join(dir, "initial-load.png"), (await win.webContents.capturePage()).toPNG());
    await win.loadFile(path.join(dir, "index.html"));
    await until(`document.querySelector('#onboarding-default')`);
    for (const [theme, width, height] of [
      ["light", 1100, 800],
      ["dark", 620, 620],
      ["light", 480, 560],
    ]) {
      win.setSize(width, height);
      await read(`onboardingSmoke.theme(${JSON.stringify(theme)}); onboardingSmoke.show('scan')`);
      await until(`document.querySelector('#onboarding-default')`);
      await capture(`agents-${theme}-${width}`);
      await read(`(() => {const el=document.querySelector('#onboarding-default');el.value='codex';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await click("Continue");
      await until(`document.activeElement?.textContent === 'Choose how OpenOrc looks'`);
      await capture(`appearance-${theme}-${width}`);
      const before = await read(`document.querySelector('.onboarding-footer').getBoundingClientRect().bottom`);
      await read(`document.querySelector('.onboarding-scroll').scrollTop=10000`);
      assert.equal(await read(`document.querySelector('.onboarding-footer').getBoundingClientRect().bottom`), before);
      await click("Continue");
      await until(`document.querySelector('h1')?.textContent === 'Bring in your first project'`);
      await capture(`project-${theme}-${width}`);
    }
    await read(`onboardingSmoke.importFails(true)`);
    await click("Choose repository");
    await until(`document.querySelector('[role="alert"]')`);
    await capture("project-error");
    await read(`onboardingSmoke.importFails(false)`);
    await click("Choose repository");
    await until(`document.querySelector('input[type="radio"]')?.checked`);
    await capture("project-selected");
    await click("Finish setup");
    await until(`document.querySelector('h1')?.textContent === 'Ready to work'`);
    await capture("complete");
    assert.equal(await read(`document.querySelector('.onboarding-mascot').dataset.mood`), "celebrating");
    assert.equal(await read(`getComputedStyle(document.querySelector('.onboarding-mascot .rive-mascot-canvas')).visibility`), "visible", "The actual Rive canvas renders the celebration");
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await read(`onboardingSmoke.show('theme')`);
    await until(`document.querySelector('h1')?.textContent === 'Choose how OpenOrc looks'`);
    await click("Dark");
    await until(`document.querySelector('.onboarding-mascot .rive-mascot')?.dataset.ready === 'false'`);
    assert.equal(await read(`getComputedStyle(document.querySelector('.onboarding-mascot .rive-mascot-canvas')).visibility`), "hidden", "Reduced motion hides the Rive canvas");
    assert.equal(await read(`getComputedStyle(document.querySelector('.onboarding-mascot .rive-mascot-static')).visibility`), "visible", "Reduced motion shows the matching still");
    await capture("mascot-reduced-motion");
    await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
    win.webContents.debugger.detach();
    await read(`onboardingSmoke.manyProjects(); onboardingSmoke.show('project')`);
    await until(`document.querySelectorAll('input[type="radio"]').length === 14`);
    await capture("long-projects");
    await read(`document.querySelector('input[type="radio"]').focus()`);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Down" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Down" });
    await until(`document.querySelectorAll('input[type="radio"]')[1].checked`);
    for (const theme of ["light", "dark"]) {
      await read(`onboardingSmoke.theme('${theme}'); onboardingSmoke.agents(['sign_in','check_failed','not_found']); onboardingSmoke.show('scan','recovery')`);
      await until(`document.querySelector('h1')?.textContent === 'Reconnect your coding agent'`);
      await capture(`recovery-${theme}`);
    }
    await win.loadFile(path.join(dir, "index.html"), { query: { appearance: "1" } });
    await until(`document.querySelectorAll('.palette-choice').length === 7`);
    win.setSize(1100, 800);
    const verifyPalette = async () => {
      const state = await read(`(() => {
        const selected = document.querySelector('.palette-choice[aria-pressed="true"]');
        const sample = document.querySelector('.palette-workspace');
        const swatches = selected.querySelector('.palette-swatches');
        return { count: document.querySelectorAll('.palette-choice[aria-pressed="true"]').length, previews: document.querySelectorAll('.palette-workspace').length, matches: sample.style.getPropertyValue('--bg') === swatches.style.getPropertyValue('--bg'), overflow: document.documentElement.scrollWidth > innerWidth };
      })()`);
      assert.deepEqual(state, { count: 1, previews: 1, matches: true, overflow: false });
      const contrast = await read(`(() => {
        const canvas = document.createElement('canvas'); canvas.width=canvas.height=1; const ctx=canvas.getContext('2d');
        const pixel = () => [...ctx.getImageData(0,0,1,1).data];
        const luminance = values => values.slice(0,3).map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
        return [...document.querySelectorAll('.palette-choice-name,.palette-workspace .sidebar-wordmark,.palette-nav-row,.palette-thread-title,.palette-thread-meta,.palette-topbar-title,.palette-user .message-bubble,.palette-reply p,.palette-reply strong,.palette-composer-placeholder,.composer-model-name,.palette-sample-caption')].map(el=>{
          const parents=[];for(let p=el;p;p=p.parentElement)parents.unshift(p);
          ctx.fillStyle='#fff';ctx.fillRect(0,0,1,1);
          for(const parent of parents){ctx.fillStyle=getComputedStyle(parent).backgroundColor;ctx.fillRect(0,0,1,1);}
          const bg=luminance(pixel());ctx.fillStyle=getComputedStyle(el).color;ctx.fillRect(0,0,1,1);const fg=luminance(pixel());
          return (Math.max(fg,bg)+0.05)/(Math.min(fg,bg)+0.05);
        });
      })()`);
      assert.ok(
        contrast.every((ratio) => ratio >= 4.5),
        `Palette text contrast: ${contrast}`,
      );
    };
    for (const mode of ["Light", "Dark"]) {
      await click(mode);
      for (const name of ["OpenOrc", "Codex", "Linear", "Cursor", "Claude", "GitHub", "Halcyon"]) {
        await click(name);
        await verifyPalette();
      }
      await fs.writeFile(path.join(dir, `palette-settings-${mode.toLowerCase()}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await read(`onboardingSmoke.color('--mascot-body','#c25490')`);
    await until(`document.querySelector('.palette-workspace').style.getPropertyValue('--mascot-body') === '#c25490'`);
    assert.equal(await read(`getComputedStyle(document.querySelector('.color-group svg path')).fill`), "rgb(194, 84, 144)", "The Colors editor's mascot wears the custom color");
    await click("Light");
    assert.notEqual(await read(`document.querySelector('.palette-workspace').style.getPropertyValue('--mascot-body')`), "#c25490", "Custom mascot colors remain specific to the appearance mode");
    await read(`document.querySelector('[aria-label="Linear palette"]').focus()`);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await until(`document.querySelector('[aria-label="Linear palette"]').getAttribute('aria-pressed') === 'true'`);
    assert.equal(await read(`localStorage.getItem('openorc.palette')`), "linear");
    for (const width of [620, 480, 340]) {
      win.setSize(width, 800);
      await pause(80);
      await verifyPalette();
      assert.equal(
        await read(`[...document.querySelectorAll('.palette-choice-name')].some(el=>el.getBoundingClientRect().height > parseFloat(getComputedStyle(el).lineHeight) + 1)`),
        false,
        "Palette names stay on one line",
      );
      assert.equal(
        await read(
          `(() => { const stage = document.querySelector('.palette-stage').getBoundingClientRect(); const scene = document.querySelector('.palette-workspace').getBoundingClientRect(); return scene.right <= stage.right + 1 && scene.width >= stage.width - 4; })()`,
        ),
        true,
        "The workspace scene fills its stage without spilling past it",
      );
      await fs.writeFile(path.join(dir, `palette-settings-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    assert.deepEqual(errors, []);
    console.log(
      `Onboarding and appearance UI passed: setup flow, focus, fixed footer, import recovery, keyboard selection, Rive rendering/reduced motion, all 14 palette/mode previews and text contrast, custom mascot colors, scaled narrow layouts, 22 captures. Screenshots: ${dir}`,
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    app.exit(1);
  }
}
(process.versions.electron ? checkUI() : buildAndRun()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
