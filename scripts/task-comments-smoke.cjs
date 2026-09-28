/** Native task discussion and handoff against a disposable profile and local scripted provider. */
const { app, utilityProcess } = require("electron");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const fixture = JSON.parse(fs.readFileSync(process.env.OPENORC_QA_FIXTURE, "utf8"));
const node = process.env.OPENORC_QA_NODE;
if (!node || !path.basename(fixture.dir).startsWith("openorc-workflow-qa-")) throw Error("Disposable fixture and Node required");
const binary = path.join(fixture.dir, "comments-codex");
fs.writeFileSync(binary, `#!${node}\nrequire(${JSON.stringify(path.resolve(__dirname, "fixtures/task-comments-provider.cjs"))});\n`, { mode: 0o755 });
// Keep the production core and real database; inject only its public shell-probe seam.
// A login-shell refresh would otherwise replace fixture binaries with installed providers.
const coreBundle = path.resolve(__dirname, "../apps/desktop/out/main/core.mjs");
const smokeBundle = path.join(path.dirname(coreBundle), `comments-smoke-${process.pid}.mjs`);
const coreSource = fs.readFileSync(coreBundle, "utf8");
const seam = "var corePromise = OpenOrc.create({";
assert.equal(coreSource.split(seam).length, 2, "Unique core factory seam");
fs.writeFileSync(
  smokeBundle,
  coreSource.replace(
    seam,
    `${seam}\n shellProbe: async () => ({path: process.env.PATH, binaries: {codex: process.env.OPENORC_CODEX_BIN, claude: process.env.OPENORC_CLAUDE_BIN, opencode: process.env.OPENORC_OPENCODE_BIN}}),`,
  ),
);
app.on("will-quit", () => fs.rmSync(smokeBundle, { force: true }));
const fork = utilityProcess.fork.bind(utilityProcess);
utilityProcess.fork = (module, args, options) =>
  fork(module === coreBundle ? smokeBundle : module, args, {
    ...options,
    env: { ...options.env, OPENORC_CODEX_BIN: binary, OPENORC_CLAUDE_BIN: binary, OPENORC_OPENCODE_BIN: binary, OPENORC_QA_PROVIDER_DIR: fixture.dir },
  });
process.env.OPENORC_USER_DATA = fixture.data;
process.env.OPENORC_ROUTE = "tasks";
process.env.OPENORC_THEME = "light";
delete process.env.ELECTRON_RENDERER_URL;
const captures = path.join(fixture.dir, "comments-captures");
fs.mkdirSync(captures, { recursive: true });
let win;
const read = (code) => win.webContents.executeJavaScript(code);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test, label) {
  const start = Date.now();
  while (!(await test())) {
    if (Date.now() - start > 20000) throw Error(label);
    await pause(60);
  }
}
async function click(text) {
  const selector = `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`;
  await until(() => read(`Boolean(${selector})`), `Missing ${text}`);
  await read(`${selector}.click()`);
}
async function type(text) {
  await read(`(()=>{const el=document.querySelector('[aria-label="Task comment"]');el.focus();el.select();})()`);
  await win.webContents.insertText(text);
}
async function run() {
  await until(() => read(`Boolean(document.querySelector('[aria-label="Filter tasks"]'))`), "Task list loaded");
  await read(
    `new Promise(resolve=>{window.addEventListener('message',function ready(event){if(event.data!=='openorc:port'||!event.ports[0])return;window.removeEventListener('message',ready);const port=event.ports[0],pending=new Map();let id=800000;port.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.type==='rpc.result'?p.resolve(data.result):p.reject(Error(data.message));};port.start();window.commentsQa=(method,params)=>new Promise((resolve,reject)=>{const next=id++;pending.set(next,{resolve,reject});port.postMessage({type:'rpc',id:next,method,params});});resolve();});window.openorc.connectBridge();})`,
  );
  const rpc = (method, params) => read(`window.commentsQa(${JSON.stringify(method)},${JSON.stringify(params)})`);
  await until(() => read(`Boolean(document.querySelector('button[title="Make the daily workflow feel effortless"]'))`), "Project threads loaded");
  await read(`document.querySelector('button[title="Make the daily workflow feel effortless"]').click()`);
  await click("Tasks");
  const task = await rpc("tasks.create", { projectId: fixture.projectId, title: "Discuss task comments", spec: "Task-owned discussion and linked execution.", workspaceMode: "current" });
  await until(() => read(`Boolean(document.querySelector('span[title="Discuss task comments"]'))`), "New task row");
  await read(`document.querySelector('span[title="Discuss task comments"]').closest('button').click()`);
  await until(() => read(`Boolean(document.querySelector('[aria-label="Task comment"]'))`), "Comment composer");
  await type("A plain note for later.");
  await click("Comment");
  await until(() => read(`document.querySelector('.task-comments-feed')?.textContent.includes('A plain note')`), "Note saved");
  assert.equal((await rpc("tasks.get", { id: task.id })).threadId, null);
  await type("@fixture");
  await until(() => read(`Boolean(document.querySelector('.task-comment-mentions [role="option"]'))`), "Model autocomplete");
  await read(`document.querySelector('.task-comment-mentions [role="option"]').click()`);
  await win.webContents.insertText("How would you implement this?");
  await click("Comment");
  await until(async () => (await rpc("tasks.comments.list", { taskId: task.id })).attempts.some((a) => a.state === "success"), "Discussion response");
  assert.equal((await rpc("tasks.get", { id: task.id })).status, "backlog");
  assert.equal((await rpc("tasks.get", { id: task.id })).threadId, null);
  await type("@codex:fixture-high @codex:fixture-low Compare approaches.");
  await click("Comment");
  await until(async () => (await rpc("tasks.comments.list", { taskId: task.id })).attempts.filter((a) => a.state === "success").length === 3, "Two independent replies");
  // Reply retains a recipient and routes explicit implementation into a thread.
  await read(`document.querySelector('.task-comment-response button').click()`);
  await type("Implement this now");
  await click("Comment");
  await until(async () => (await rpc("tasks.comments.list", { taskId: task.id })).attempts.some((a) => a.state === "completed"), "Execution result returned");
  const result = (await rpc("tasks.comments.list", { taskId: task.id })).attempts.find((a) => a.executionRunId);
  assert.ok(result.threadId);
  assert.match(result.body, /Implemented and verified/);
  const providerTurns = fs.readFileSync(path.join(fixture.dir, "comment-provider.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const resumedReply = providerTurns.find((turn) => turn.discussion && turn.work);
  assert.equal(resumedReply.resumed, true, "Reply resumes the provider session");
  assert.equal(resumedReply.sessionId, providerTurns[0].sessionId, "Reply continues the addressed response's session");
  assert.equal(providerTurns.find((turn) => !turn.discussion).resumed, false, "Execution keeps its own session");
  assert.equal(await read(`Boolean(document.querySelector('[aria-label="Task comment"]'))`), true, "Stay on the task");
  const metrics = [];
  for (const [width, theme] of [
    [1200, "light"],
    [800, "dark"],
  ]) {
    win.setSize(width, 900);
    await read(
      `localStorage.setItem("openorc.theme",${JSON.stringify(theme)});window.dispatchEvent(new StorageEvent("storage",{key:"openorc.theme",newValue:${JSON.stringify(theme)}}));document.querySelector('.task-comments').scrollIntoView({block:'start'})`,
    );
    await pause(150);
    const measured = await read(`(() => {
      const root = getComputedStyle(document.documentElement), box = document.querySelector('.task-comment-composer'), input = box.querySelector('textarea');
      const rgb = color => { if (color.startsWith('#')) return color.slice(1).match(/../g).map(v=>parseInt(v,16)/255); const v = color.match(/[0-9.]+/g).map(Number); return color.startsWith('color(') ? v.slice(0,3) : v.slice(0,3).map(v=>v/255); };
      const lum = color => rgb(color).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[0.2126,0.7152,0.0722][i],0);
      const bg = getComputedStyle(box).backgroundColor, fg = getComputedStyle(input,'::placeholder').color, surface = root.getPropertyValue('--surface').trim();
      const values = [lum(bg),lum(fg)];
      return {theme:document.documentElement.dataset.theme, background:bg,surface,placeholder:fg,contrast:(Math.max(...values)+0.05)/(Math.min(...values)+0.05),lighter:lum(bg)>lum(surface)};
    })()`);
    metrics.push(measured);
    fs.writeFileSync(path.join(captures, "metrics.json"), JSON.stringify(metrics, null, 2));
    assert.equal(measured.theme, theme);
    assert.ok(measured.contrast >= 4.5, "Readable composer placeholder");
    assert.equal(measured.lighter, true, "Writing surface is lighter than the document");
    assert.equal(await read(`document.documentElement.scrollWidth>innerWidth`), false);
    assert.equal(await read(`[...document.querySelectorAll('.task-comments *')].some(el=>el.getBoundingClientRect().right>innerWidth+1)`), false, "Comments fit narrow view");
    fs.writeFileSync(path.join(captures, `${theme}.png`), (await win.webContents.capturePage()).toPNG());
    await read(`document.querySelector('.task-comment-composer').scrollIntoView({block:'end'})`);
    await pause(80);
    fs.writeFileSync(path.join(captures, `${theme}-composer.png`), (await win.webContents.capturePage()).toPNG());
  }
  fs.writeFileSync(path.join(captures, "metrics.json"), JSON.stringify(metrics, null, 2));
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "plain note",
        "autocomplete",
        "discussion without thread",
        "multiple independent recipients",
        "Reply recipient",
        "Reply session reuse",
        "linked execution",
        "result returned",
        "light/dark narrow layouts",
      ],
      captures,
    }),
  );
}
app.on("browser-window-created", (_event, window) => {
  win = window;
  win.webContents.setBackgroundThrottling(false);
  win.webContents.once(
    "did-finish-load",
    () =>
      void run()
        .then(() => app.quit())
        .catch(async (error) => {
          console.error(error);
          console.error(await read("document.body.innerText"));
          app.exit(1);
        }),
  );
});
require(path.resolve(__dirname, "../apps/desktop/out/main/index.mjs"));
