/** Run after node apps/desktop/mascot-review.mjs. Synthetic data, no agent runs. */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
app.setPath("userData", "/tmp/openorc-fast-effects-profile");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let win;
const errors = [],
  requests = [],
  checks = [];
const read = (code) => win.webContents.executeJavaScript(code);
async function until(code) {
  for (let i = 0; i < 100; i++) {
    if (await read(code)) return;
    await pause(80);
  }
  throw Error("Timed out: " + code + "\n" + errors.join("\n"));
}
async function click(selector) {
  await read(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await pause(100);
}
async function selectModel(label) {
  await read(
    `(()=>{const e=document.querySelector('input[aria-label="Search models"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(label)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await until(`Array.from(document.querySelectorAll('.model-picker-row')).some(e=>e.textContent.includes(${JSON.stringify(label)}))`);
  await read(`Array.from(document.querySelectorAll('.model-picker-row')).find(e=>e.textContent.includes(${JSON.stringify(label)})).click()`);
  await read(
    `(()=>{const e=document.querySelector('input[aria-label="Search models"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
}
async function key(keyCode) {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode });
  await pause(100);
}
async function capture(name) {
  const rect = await read(
    `(()=>{const r=document.querySelector('.model-picker-popup').getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)-6),y:Math.max(0,Math.floor(r.y)-6),width:Math.ceil(r.width)+12,height:Math.ceil(r.height)+12}})()`,
  );
  await fs.writeFile("/tmp/openorc-fast-" + name + ".png", (await win.webContents.capturePage(rect)).toPNG());
}
(async () => {
  await app.whenReady();
  await fs.writeFile(
    "/tmp/fast-effects-preload.cjs",
    `const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('openorc',{platform:'darwin',onFullscreen:()=>()=>{},isFullscreen:async()=>false,syncWindowChrome:async()=>1,openExternal:()=>{}});`,
  );
  win = new BrowserWindow({ width: 1000, height: 850, show: false, webPreferences: { preload: "/tmp/fast-effects-preload.cjs", backgroundThrottling: false, partition: "fast-effects" } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    requests.push(details.url);
    callback({ cancel: /^https?:/.test(details.url) });
  });
  await win.loadFile("/tmp/openorc-mascot-review-dist/mascot-review.html");
  await until(`document.querySelector('.composer-model-trigger')?.textContent.includes('Medium')`);
  await read(`mascotReview.theme.getState().set('dark');mascotReview.theme.getState().setPreset('linear')`);
  await click(".composer-model-trigger");
  assert.equal(await read(`document.activeElement===document.querySelector('input[aria-label="Search models"]')`), false, "opening the picker must not focus search");
  await read(`document.querySelector('input[aria-label="Search models"]').focus()`);
  assert.equal(await read(`getComputedStyle(document.querySelector('.model-picker-search')).outlineStyle`), "none");
  assert.equal(await read(`getComputedStyle(document.querySelector('input[aria-label="Search models"]')).outlineStyle`), "none");
  await read(`document.querySelector('input[aria-label="Search models"]').blur()`);
  assert.equal(await read(`document.querySelector('.model-picker-fast').disabled`), false);
  assert.equal(await read(`document.querySelector('.composer-effort-slider').hasAttribute('data-max')`), false);
  await click(".model-picker-fast");
  await until(`document.querySelectorAll('.fast-mode-rocket[data-ready="true"]').length===1`);
  assert.equal(await read(`document.querySelector('.model-picker-fast').getAttribute('aria-pressed')`), "true");
  const ink = await read(
    `(()=>{const c=document.querySelector('.fast-mode-flight canvas'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let count=0;for(let i=3;i<p.length;i+=4)if(p[i]>200)count++;return count})()`,
  );
  assert.ok(ink > 25, "rocket actually draws");
  const bodyHeight = await read(
    `(()=>{const c=document.querySelector('.fast-mode-flight canvas'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let min=c.height,max=0;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;if(p[i]>210&&p[i+1]>215&&p[i+2]>230&&p[i+3]>240){min=Math.min(min,y);max=Math.max(max,y);}}return (max-min+1)/c.height*c.clientHeight})()`,
  );
  assert.ok(bodyHeight >= 16 && bodyHeight <= 20, "capsule is compact within the 28px slider: " + bodyHeight);

  const frame = await read(`document.querySelector('.fast-mode-flight canvas').toDataURL()`);
  await pause(350);
  assert.notEqual(await read(`document.querySelector('.fast-mode-flight canvas').toDataURL()`), frame, "rocket animates");
  const flight = await read(
    `(()=>{const rocket=document.querySelector('.fast-mode-rocket'),animation=rocket.getAnimations().find(a=>a.animationName==='rocket-launch');animation.pause();const samples=[0,450,900].map(time=>{animation.currentTime=time;return parseFloat(getComputedStyle(rocket).left)});animation.finish();const knob=(32+Number(document.querySelector('input[aria-label="Reasoning effort"]').value)/Number(document.querySelector('input[aria-label="Reasoning effort"]').max)*(document.querySelector('.composer-effort-slider').clientWidth-64));return {samples,knob}})()`,
  );
  assert.ok(flight.samples[0] < flight.samples[1] && flight.samples[1] < flight.samples[2]);
  assert.ok(Math.abs(flight.samples[2] - flight.knob) < 1, "flight terminates at knob");
  assert.equal(await read(`document.querySelector('.model-picker-fast [data-icon="Zap"]')!==null`), true);
  assert.equal(await read(`document.querySelector('.composer-effort-thumb')===null`), true, "rocket replaces the normal knob");
  await capture("enabled");
  checks.push("Fast launches the illustrated Rive rocket as the slider thumb, with no white knob");
  await read(`document.querySelector('input[aria-label="Reasoning effort"]').focus()`);
  await key("End");
  await until(`document.querySelector('.composer-effort-slider[data-max]')`);
  await pause(200);
  assert.equal(await read(`document.querySelector('input[aria-label="Reasoning effort"]').getAttribute('aria-valuetext')`), "Ultra");
  assert.equal(await read(`document.querySelector('input[aria-label="Reasoning effort"]').max`), "5", "Astra keeps Max and Ultra as separate effort stops");
  await read(`document.querySelector('input[aria-label="Reasoning effort"]').focus()`);
  await key("Left");
  assert.equal(await read(`document.querySelector('input[aria-label="Reasoning effort"]').getAttribute('aria-valuetext')`), "Max");
  await key("End");
  assert.equal(
    await read(
      `Math.abs(parseFloat(getComputedStyle(document.querySelector('.fast-mode-rocket')).left)-(32+Number(document.querySelector('input[aria-label="Reasoning effort"]').value)/Number(document.querySelector('input[aria-label="Reasoning effort"]').max)*(document.querySelector('.composer-effort-slider').clientWidth-64)))<1`,
    ),
    true,
    "rocket follows knob after effort changes",
  );
  assert.match(await read(`getComputedStyle(document.querySelector('.composer-effort-fill')).backgroundImage`), /linear-gradient/);
  assert.equal(await read(`getComputedStyle(document.querySelector('.composer-effort-ticks')).visibility`), "hidden");
  for (const mode of ["light", "dark"])
    for (const palette of ["codex", "linear", "cursor", "claude", "github"]) {
      await read(`mascotReview.theme.getState().set('${mode}');mascotReview.theme.getState().setPreset('${palette}')`);
      await pause(300);
      assert.match(await read(`getComputedStyle(document.querySelector('.composer-effort-fill')).backgroundImage`), /radial-gradient/);
      assert.equal(await read(`getComputedStyle(document.querySelector('.fast-mode-rocket')).color`), "rgb(168, 121, 220)", "rocket stays lavender across app accents");
      assert.equal(await read(`document.querySelector('.model-picker-fast').getAttribute('aria-pressed')`), "true");
      if (palette === "linear") await capture("max-" + mode);
    }
  checks.push("End selects maximum effort and the lavender gradient works across all ten appearance combinations");
  await until(`document.querySelector('.effort-galaxy')?.dataset.running==='true'`);
  const layerState = () => read(`Array.from(document.querySelectorAll('.effort-galaxy > span')).map(e=>getComputedStyle(e).transform)`);
  const before = await layerState();
  await pause(180);
  const after = await layerState();
  assert.ok(
    before.every((v, i) => v !== after[i]),
    "clouds and both star layers move",
  );
  await read(`document.querySelector('.effort-galaxy').style.transform='translateY(3000px)'`);
  await until(`document.querySelector('.effort-galaxy')?.dataset.running==='false'`);
  const paused = await layerState();
  await pause(150);
  assert.deepEqual(await layerState(), paused, "offscreen galaxy pauses");
  await read(`document.querySelector('.effort-galaxy').style.transform=''`);
  checks.push("compact capsule; galaxy clouds and stars move at separate speeds and pause offscreen");

  const slider = await read(`(()=>{const r=document.querySelector('input[aria-label="Reasoning effort"]').getBoundingClientRect();return {x:r.x,y:r.y+r.height/2,width:r.width}})()`);
  const point = { x: Math.round(slider.x + slider.width - 32 - 10), y: Math.round(slider.y) };
  win.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  await pause(50);
  assert.equal(await read(`document.querySelector('input[aria-label="Reasoning effort"]').value`), "5", "grabbing the rocket wing does not change effort");
  win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(slider.x), y: point.y });
  win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(slider.x), y: point.y, button: "left", clickCount: 1 });
  await pause(200);
  assert.equal(await read(`document.querySelector('input[aria-label="Reasoning effort"]').value`), "0");
  assert.equal(
    await read(
      `(()=>{const r=document.querySelector('.fast-mode-rocket').getBoundingClientRect(),t=document.querySelector('.composer-effort-slider').getBoundingClientRect();return r.left>=t.left-1&&r.right<=t.right+1})()`,
    ),
    true,
    "minimum keeps whole rocket visible",
  );
  win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(slider.x + 32), y: point.y, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(slider.x + slider.width), y: point.y });
  win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(slider.x + slider.width), y: point.y, button: "left", clickCount: 1 });
  await pause(200);
  assert.equal(await read(`document.querySelector('input[aria-label="Reasoning effort"]').value`), "5");
  assert.equal(
    await read(
      `(()=>{const r=document.querySelector('.fast-mode-rocket').getBoundingClientRect(),t=document.querySelector('.composer-effort-slider').getBoundingClientRect();return r.left>=t.left-1&&r.right<=t.right+1})()`,
    ),
    true,
    "maximum keeps whole rocket visible",
  );
  checks.push("rocket supports off-center grabs and pointer dragging across the full range without clipping");

  await click('[aria-label="Reset effort to model default"]');
  assert.equal(await read(`document.querySelector('.composer-effort-slider').hasAttribute('data-max')`), false);
  assert.equal(await read(`document.querySelector('input[aria-label="Reasoning effort"]').getAttribute('aria-valuetext')`), "Medium");
  assert.equal(await read(`document.querySelector('.model-picker-fast').getAttribute('aria-pressed')`), "true");
  await click(".model-picker-fast");
  await until(`document.querySelectorAll('.fast-mode-rocket').length===0`);
  assert.equal(await read(`document.querySelector('.composer-effort-thumb')!==null`), true, "normal knob returns when Fast is off");
  assert.equal(await read(`document.querySelector('.model-picker-fast').getAttribute('aria-pressed')`), "false");
  checks.push("reset removes maximum treatment without changing Fast; switching Fast off removes the slider rocket");
  await selectModel("Model with High maximum");
  await until(`document.querySelector('input[aria-label="Reasoning effort"]')?.max==='1'`);
  await read(`document.querySelector('input[aria-label="Reasoning effort"]').focus()`);
  await key("End");
  assert.equal(await read(`document.querySelector('input[aria-label="Reasoning effort"]').getAttribute('aria-valuetext')`), "High");
  assert.equal(await read(`document.querySelector('.composer-effort-slider').hasAttribute('data-max')`), true);
  assert.equal(await read(`document.querySelector('.model-picker-fast').disabled`), true);
  checks.push("maximum follows provider effort options, including High; unsupported Fast remains disabled");
  await selectModel("GPT-6-Astra");
  await until(`document.querySelector('.model-picker-fast')?.disabled===false`);
  await click(".model-picker-fast");
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await until(`document.querySelectorAll('.fast-mode-rocket[data-ready="false"]').length===1`);
  assert.equal(await read(`getComputedStyle(document.querySelector('.fast-mode-flight .fast-mode-rocket-static')).visibility`), "visible");
  assert.equal(await read(`getComputedStyle(document.querySelector('.fast-mode-rocket')).animationName`), "none");
  await read(`document.querySelector('input[aria-label="Reasoning effort"]').focus()`);
  await key("End");
  assert.equal(await read(`document.querySelector('.composer-effort-slider').hasAttribute('data-max')`), true);
  assert.equal(await read(`Array.from(document.querySelectorAll('.effort-galaxy > span')).every(e=>getComputedStyle(e).animationName==='none')`), true, "reduced motion stops galaxy layers");
  win.setSize(540, 650);
  await pause(150);
  await capture("narrow-reduced");
  const fits = await read(`(()=>{const r=document.querySelector('.model-picker-popup').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`);
  assert.ok(fits, "popup fits small window");
  await key("Escape");
  await until(`!document.querySelector('.model-picker-popup')`);
  await click(".composer-model-trigger");
  await until(`document.querySelector('.composer-effort-slider[data-max]')`);
  assert.equal(await read(`document.querySelector('.model-picker-fast').getAttribute('aria-pressed')`), "true");
  checks.push("reduced motion shows static rocket; narrow layout and reopening preserve both states");

  // The account loses Fast while it is on: the saved request stays so it can be turned off, but nothing claims Fast runs.
  await read(`mascotReview.blockFast("Usage credits are off for this account.")`);
  await until(`document.querySelectorAll('.fast-mode-rocket').length===0`);
  assert.equal(await read(`document.querySelector('.composer-effort-thumb')!==null`), true, "the normal knob replaces the rocket");
  assert.equal(await read(`document.querySelector('.composer-fast-indicator').getAttribute('aria-label')`), "Fast mode can't run");
  const warns = (selector) =>
    read(
      `(()=>{const probe=document.createElement('span');probe.style.color='var(--warn)';document.body.append(probe);const same=getComputedStyle(document.querySelector(${JSON.stringify(selector)})).color===getComputedStyle(probe).color;probe.remove();return same})()`,
    );
  assert.equal(await warns(".composer-fast-indicator"), true, "the composer icon turns to the warning color");
  assert.equal(await warns(".model-picker-fast"), true, "the pressed toggle warns instead of using the accent");
  assert.equal(
    await read(`document.getElementById(document.querySelector('.model-picker-fast').getAttribute('aria-describedby')).textContent`),
    "Fast can't run. Usage credits are off for this account.",
  );
  assert.equal(
    await read(`Array.from(document.querySelectorAll('.model-picker-effort-hint')).some(e=>e.textContent==="Fast can't run. Usage credits are off for this account.")`),
    true,
    "the reason is visible",
  );
  assert.equal(await read(`document.querySelector('.model-picker-fast').disabled`), false, "a request that cannot run can still be turned off");
  await click(".model-picker-fast");
  await until(`!document.querySelector('.composer-fast-indicator')`);
  assert.equal(await read(`document.querySelector('.model-picker-fast').disabled`), true, "and cannot be turned back on");
  checks.push("an account without Fast drops the rocket, marks the saved request as unable to run, and still lets it be turned off");
  assert.deepEqual(errors, []);
  assert.equal(
    requests.some((u) => /^https?:/.test(u)),
    false,
  );
  await fs.writeFile("/tmp/openorc-fast-effects-checks.json", JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }));
  app.quit();
})().catch(async (error) => {
  console.error(error);
  if (win) console.error(await read("document.body.innerText"));
  app.exit(1);
});
