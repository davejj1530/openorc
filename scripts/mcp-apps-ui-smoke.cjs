/** Real AppBridge, core service, HTTP sandbox and Chromium; no user profile or model calls. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const desktop = path.join(root, "apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildAndRun() {
  const dir = await fs.mkdtemp("/tmp/openorc-mcp-apps-smoke-");
  const { build } = require(require.resolve("esbuild", { paths: [path.dirname(require.resolve("tsx/package.json", { paths: [root] }))] }));
  await require("./build-transcript-fixture.cjs")(dir, "mcp-apps-ui.tsx");
  for (const [name, entry] of Object.entries({ sandbox: "apps/desktop/src/main/mcp-app-sandbox.ts", service: "packages/core/src/services/mcp-apps.ts" }))
    await build({ entryPoints: [path.join(root, entry)], outfile: path.join(dir, `${name}.cjs`), bundle: true, platform: "node", format: "cjs" });
  await fs.writeFile(
    path.join(dir, "preload.cjs"),
    `const {contextBridge,ipcRenderer}=require('electron');
    contextBridge.exposeInMainWorld('openorc',{mcpApps:{register:doc=>ipcRenderer.invoke('sandbox:register',doc),release:id=>ipcRenderer.send('sandbox:release',id)}});
    contextBridge.exposeInMainWorld('mcpFixture',{call:(method,params)=>ipcRenderer.invoke('fixture:call',method,params)});`,
  );
  const env = { ...process.env, OPENORC_MCP_APPS_UI_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

function appHtml(kind) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{font:14px system-ui;margin:0;padding:20px;background:#fff;color:#222}body.dark{background:#222;color:#eee}button{font:inherit;padding:8px 16px;margin:16px 8px 0 0}#cards{display:flex;gap:12px;flex-wrap:wrap}.card{border:1px solid #888;border-radius:8px;padding:16px;min-width:120px}p{line-height:1.5}</style></head><body>
    <h2>${kind === "gallery" ? "Reference gallery" : "Weather outlook"}</h2><div id="cards"></div><p id="status">Initializing</p><button id="refresh">Refresh</button><button id="escape">Forbidden tool</button>
    <script>
    let sequence=1, pending=new Map();
    const send=(method,params)=>parent.postMessage({jsonrpc:'2.0',method,params},'*');
    const request=(method,params)=>new Promise((resolve,reject)=>{const id=sequence++;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*')});
    const theme=context=>{if(context.theme){document.body.className=context.theme;document.body.dataset.theme=context.theme}};
    addEventListener('message',e=>{if(e.source!==parent)return;const m=e.data;
      if(m.id && pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}
      if(m.method==='ui/notifications/tool-result'){document.getElementById('cards').textContent=JSON.stringify(m.params.structuredContent);document.getElementById('status').textContent='Ready';document.body.dataset.result='ready';}
      if(m.method==='ui/notifications/host-context-changed')theme(m.params);
      if(m.method==='ui/resource-teardown')parent.postMessage({jsonrpc:'2.0',id:m.id,result:{}},'*');
    });
    request('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'${kind}',version:'1.0'},appCapabilities:{}}).then(result=>{theme(result.hostContext);send('ui/notifications/initialized',{});send('ui/notifications/size-changed',{height:320});});
    document.getElementById('refresh').onclick=()=>request('tools/call',{name:'refresh',arguments:{page:2}}).then(r=>document.getElementById('status').textContent=r.content[0].text);
    document.getElementById('escape').onclick=()=>request('tools/call',{name:'unrelated.delete',arguments:{}}).catch(e=>document.getElementById('status').textContent=e.message);
    try{parent.document.body.dataset.escaped='yes';document.body.dataset.isolated='no'}catch{document.body.dataset.isolated='yes'}
    document.body.dataset.node=typeof require+':'+typeof window.openorc;
    fetch('https://example.com/disallowed').then(()=>document.body.dataset.network='allowed').catch(()=>document.body.dataset.network='blocked');
    </script></body></html>`;
}

async function check() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const dir = process.env.OPENORC_MCP_APPS_UI_DIR;
  app.setPath("userData", path.join(dir, "profile"));
  await app.whenReady();
  const { McpAppSandbox } = require(path.join(dir, "sandbox.cjs"));
  const { McpAppService } = require(path.join(dir, "service.cjs"));
  const sandbox = new McpAppSandbox();
  await sandbox.start();
  let mobbin;
  let mobbinResult;
  if (process.env.OPENORC_MOBBIN_RESOURCE) mobbin = JSON.parse(await fs.readFile(process.env.OPENORC_MOBBIN_RESOURCE, "utf8"));
  if (process.env.OPENORC_MOBBIN_RESULT) mobbinResult = JSON.parse(await fs.readFile(process.env.OPENORC_MOBBIN_RESULT, "utf8"));
  const calls = [];
  const connection = {
    listTools: async (server) => [
      { name: "show", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: server === "mobbin" ? "ui://mobbin/search-screens.html" : `ui://${server}/index.html` } } },
      { name: "refresh", inputSchema: { type: "object" } },
    ],
    readResource: async (source, uri) => (source.server === "mobbin" ? mobbin : { contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: appHtml(source.server) }] }),
    callTool: async (server, name, args) => {
      calls.push({ server, name, args });
      return { content: [{ type: "text", text: "Refreshed page 2" }] };
    },
  };
  const service = new McpAppService({
    call: (runId, id) => ({
      type: "tool.completed",
      runId,
      ts: 1,
      toolCallId: id,
      name: `${id}.show`,
      mcp: { server: id, tool: "show" },
      input: { query: "Appearance", platform: "web" },
      output: id === "mobbin" && mobbinResult ? mobbinResult : { content: [], structuredContent: id === "weather" ? { forecast: "Sunny", temperature: 24 } : { screens: [] } },
      isError: false,
    }),
    connection: () => connection,
    approve: async () => true,
  });
  ipcMain.handle("sandbox:register", (event, doc) => sandbox.register(event.sender.id, doc));
  ipcMain.on("sandbox:release", (event, id) => sandbox.release(event.sender.id, id));
  ipcMain.handle("fixture:call", (_event, method, p) => {
    if (method === "mcpApps.open") {
      if (p.toolCallId === "unsupported") return { status: "unavailable", message: "This provider cannot host interactive apps." };
      if (p.toolCallId === "missing") return { status: "unavailable", message: "The app resource was not found." };
      return service.open(p.runId, p.toolCallId);
    }
    if (method === "mcpApps.close") {
      service.close(p.viewId);
      return null;
    }
    if (method === "mcpApps.call") return service.callTool(p.viewId, p.name, p.arguments);
    if (method === "mcpApps.read") return service.readResource(p.viewId, p.uri);
    return null;
  });
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { preload: path.join(dir, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const read = (code) => win.webContents.executeJavaScript(code);
  const links = [];
  win.webContents.setWindowOpenHandler(({ url }) => {
    links.push(url);
    return { action: "deny" };
  });
  const click = async (name) => {
    await read(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(name)}).click()`);
    await pause(100);
  };
  const view = () => win.webContents.mainFrame.frames.flatMap((frame) => frame.frames).find((frame) => frame.url.endsWith("/view"));
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 100; i++) {
      if (await predicate()) return;
      await pause(100);
    }
    throw Error("Timed out: " + label);
  };
  try {
    await win.loadFile(path.join(dir, "index.html"));
    for (const kind of ["gallery", "weather"]) {
      if (kind !== "gallery") await click(kind);
      await waitFor(async () => view() && (await view().executeJavaScript(`document.body.dataset.result==='ready'`)), kind + " initialization");
      const state = await view().executeJavaScript(`({...document.body.dataset})`);
      assert.equal(state.isolated, "yes");
      assert.equal(state.node, "undefined:undefined");
      assert.equal(state.network, "blocked");
      await view().executeJavaScript(`document.getElementById('refresh').click()`);
      await waitFor(async () => /Refreshed page 2/.test(await view().executeJavaScript("document.body.innerText")), "tool response");
      assert.equal(calls.at(-1).server, kind);
      await view().executeJavaScript(`document.getElementById('escape').click()`);
      await waitFor(async () => /not available/.test(await view().executeJavaScript("document.body.innerText")), "scoped rejection");
      assert.equal(calls.length, kind === "gallery" ? 1 : 2);
      await click("Switch theme");
      await waitFor(async () => (await view().executeJavaScript("document.body.dataset.theme")) === (await read("document.documentElement.dataset.theme")), "theme change");
      for (const width of [1100, 390]) {
        win.setSize(width, 800);
        await pause(120);
        assert.equal(await read("document.documentElement.scrollWidth<=innerWidth"), true);
        await fs.writeFile(path.join(dir, `${kind}-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    await click("Close app");
    await waitFor(() => !view(), "teardown");
    await click("Open interactive app");
    await waitFor(async () => view() && (await view().executeJavaScript(`document.body.dataset.result==='ready'`)), "reopen");
    for (const kind of ["unsupported", "missing"]) {
      await click(kind);
      assert.equal(!!view(), false);
      assert.match(await read("document.body.innerText"), /Reload app/);
    }
    if (mobbin) {
      win.setSize(1100, 800);
      await click("mobbin");
      await waitFor(async () => view() && !(await read("document.body.innerText")).includes("Loading interactive app"), "live Mobbin document handshake");
      await pause(1500);
      assert.equal((await read("document.body.innerText")).includes("too long"), false);
      const body = await view().executeJavaScript("document.body.innerText");
      assert.ok(body.trim().length > 0, "Mobbin renders its gallery UI");
      if (mobbinResult) {
        await waitFor(async () => view().executeJavaScript(`Array.from(document.images).filter(i=>i.complete && i.naturalWidth>0).length>=3`), "Mobbin screenshots");
        await view().executeJavaScript(`document.querySelector('img').click()`);
        await waitFor(() => links.length > 0, "Mobbin open-link request");
        assert.match(links.at(-1), /^https:\/\/mobbin.com\/screens\//);
      }
      await fs.writeFile(path.join(dir, "mobbin.png"), (await win.webContents.capturePage()).toPNG());
      console.log("Live Mobbin resource rendered:", body.slice(0, 300));
    }
    console.log("MCP Apps Chromium smoke passed:", dir);
  } finally {
    win.destroy();
    await sandbox.close();
    app.quit();
  }
}
(process.versions.electron ? check() : buildAndRun()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
  if (process.versions.electron) require("electron").app.quit();
});
