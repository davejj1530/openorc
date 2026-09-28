/** Production file:// notification coordination, with the OS Notification constructor replaced. */
const { app, BrowserWindow, utilityProcess } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const fixture = JSON.parse(fs.readFileSync(process.env.OPENORC_QA_FIXTURE, "utf8"));
if (!path.basename(fixture.dir).startsWith("openorc-workflow-qa-")) throw Error("Disposable qa-seed fixture required");
process.env.OPENORC_USER_DATA = fixture.data;
process.env.OPENORC_ROUTE = "newthread";
delete process.env.ELECTRON_RENDERER_URL;
const fork = utilityProcess.fork.bind(utilityProcess);
utilityProcess.fork = (module, args, options) => fork(module, args, { ...options, env: { ...options.env, OPENORC_CODEX_BIN: "/usr/bin/false", OPENORC_CLAUDE_BIN: "/usr/bin/false" } });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Native notification probe timed out")), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const read = (win, code) => bounded(win.webContents.executeJavaScript(code));
async function until(check, label) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > 10000) throw Error("Timed out: " + label);
    await pause(50);
  }
}
let primary;
const checks = [];
async function installMock(win) {
  await read(
    win,
    `(() => {
    window.Notification=class { static permission='granted'; constructor(title,options){ const entries=JSON.parse(localStorage.getItem('qa.notification.os')||'[]');entries.push({title,id:options.tag});localStorage.setItem('qa.notification.os',JSON.stringify(entries)); } };
    const channel=new MessageChannel();window.qaNotificationPort=channel.port1;
    channel.port1.onmessage=({data})=>{ if(data.type==='rpc'&&data.method==='app.settings.get')channel.port1.postMessage({type:'rpc.result',id:data.id,result:{notifications:true,sound:false}}); };
    window.postMessage('openorc:port','*',[channel.port2]);
  })()`,
  );
  await pause(50);
}
async function run() {
  await until(() => read(primary, `Boolean(document.querySelector('.new-thread-composer textarea'))`), "first renderer");
  delete process.env.OPENORC_ROUTE;
  const secondary = new BrowserWindow({
    show: false,
    width: 1000,
    height: 760,
    webPreferences: { preload: path.join(root, "apps/desktop/out/preload/index.js"), sandbox: true, contextIsolation: true, additionalArguments: [`--openorc-route=thread:${fixture.threadId}`] },
  });
  primary.webContents.setBackgroundThrottling(false);
  secondary.webContents.setBackgroundThrottling(false);
  await secondary.loadFile(path.join(root, "apps/desktop/out/renderer/index.html"));
  await until(() => read(secondary, `Boolean(document.querySelector('textarea[aria-label="Message"]'))`), "second renderer thread");
  assert.equal(await read(secondary, "window.openorc.autorun.route"), `thread:${fixture.threadId}`);
  const capabilities = await read(primary, `({protocol:location.protocol,secure:isSecureContext,locks:Boolean(navigator.locks),channel:typeof BroadcastChannel})`);
  assert.equal(capabilities.protocol, "file:");
  assert.equal(capabilities.locks, true);
  assert.equal(capabilities.channel, "function");
  await read(primary, `localStorage.setItem('qa.notification.shared','visible to both')`);
  assert.equal(await read(secondary, `localStorage.getItem('qa.notification.shared')`), "visible to both");
  await read(
    primary,
    `window.qaLockDone=navigator.locks.request('qa.notification.proof',async()=>{window.qaLockHeld=true;localStorage.setItem('qa.notification.trace','first');await new Promise(resolve=>window.qaReleaseLock=resolve);});void 0`,
  );
  await until(() => read(primary, "window.qaLockHeld===true"), "first acquired Web Lock");
  const secondLock = read(
    secondary,
    `navigator.locks.request('qa.notification.proof',()=>{localStorage.setItem('qa.notification.trace',localStorage.getItem('qa.notification.trace')+',second');return localStorage.getItem('qa.notification.trace');})`,
  );
  await pause(100);
  assert.equal(await read(primary, `localStorage.getItem('qa.notification.trace')`), "first");
  await read(primary, `window.qaReleaseLock();void 0`);
  assert.equal(await secondLock, "first,second");
  checks.push("Built file:// renderers share working Web Locks, BroadcastChannel capability and localStorage.");
  await installMock(primary);
  await installMock(secondary);
  await read(primary, `localStorage.setItem('qa.notification.os','[]')`);
  secondary.show();
  secondary.focus();
  secondary.webContents.focus();
  await until(() => read(secondary, "document.hasFocus()"), "target window focused");
  const post = async (win, notice) => read(win, `window.qaNotificationPort.postMessage(${JSON.stringify(notice)})`);
  const note = {
    type: "notify",
    kind: "approval",
    title: "Scripted notification",
    body: "No operating system notification will be shown.",
    threadId: fixture.threadId,
    taskId: null,
    id: "native-visible-proof",
  };
  await Promise.all([post(primary, note), post(secondary, note)]);
  await pause(600);
  assert.deepEqual(await read(primary, `JSON.parse(localStorage.getItem('qa.notification.os'))`), []);
  checks.push("The production visibility responder suppresses both receivers when another focused window displays the target.");
  const elsewhere = { ...note, id: "native-once-proof", threadId: "not-on-screen" };
  await Promise.all([post(primary, elsewhere), post(secondary, elsewhere)]);
  await until(() => read(primary, `JSON.parse(localStorage.getItem('qa.notification.os')).length===1`), "one coordinated mock OS delivery");
  await pause(300);
  assert.equal(await read(primary, `JSON.parse(localStorage.getItem('qa.notification.os')).length`), 1);
  const loaded = new Promise((resolve) => primary.webContents.once("did-finish-load", resolve));
  primary.webContents.reload();
  await bounded(loaded);
  await until(() => read(primary, `Boolean(document.querySelector('.new-thread-composer textarea'))`), "reloaded first renderer");
  await installMock(primary);
  await Promise.all([post(primary, elsewhere), post(secondary, elsewhere)]);
  await pause(400);
  assert.equal(await read(primary, `JSON.parse(localStorage.getItem('qa.notification.os')).length`), 1);
  checks.push("The actual renderer pipeline delivers once across two windows and retains dedupe after reload; the OS API is mocked.");
  const report = { checks, capabilities, realOsNotifications: false, realProviders: false };
  fs.writeFileSync(path.join(fixture.dir, "orchestration-notifications-report.json"), JSON.stringify(report, null, 2));
  console.log("[orchestration-notifications-qa]", JSON.stringify(report));
  secondary.destroy();
  app.quit();
}
app.on("browser-window-created", (_event, win) => {
  if (primary) return;
  primary = win;
  win.webContents.once(
    "did-finish-load",
    () =>
      void run().catch((error) => {
        console.error("[orchestration-notifications-qa-failed]", error);
        app.exit(1);
      }),
  );
});
require(path.join(root, "apps/desktop/out/main/index.mjs"));
